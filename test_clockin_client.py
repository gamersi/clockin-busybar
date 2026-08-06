import asyncio
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, Mock, patch

from busylib.exceptions import BusyBarAPIError

from busybar import (
    BusyBarConfig,
    BusyBarController,
    BusyBarRenderer,
    ClockDisplayState,
    ClockMode,
    button_event,
)
from main import (
    ClockinClient,
    clear_config,
    display_state,
    format_duration,
    load_config,
    parse_login_token,
    parse_tokens,
    print_summary,
    resolve_site,
    save_config,
)


class ClientHelpersTest(unittest.TestCase):
    def test_saves_and_loads_private_local_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "clockin", "config.json")
            expected = {"email": "you@example.com", "password": "secret"}

            save_config(path, expected)

            self.assertEqual(load_config(path), expected)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertTrue(clear_config(path))
            self.assertEqual(load_config(path), {})

    def test_parses_the_two_distinct_tokens(self) -> None:
        parser = parse_tokens(
            '<input type="hidden" name="_token" value="form123">'
            '<meta name="csrf-token" content="meta456">'
        )

        self.assertEqual(parser.form_token, "form123")
        self.assertEqual(parser.csrf_token, "meta456")

    def test_uses_meta_token_when_login_has_no_hidden_input(self) -> None:
        html = '<meta name="csrf-token" content="meta456">'

        self.assertEqual(parse_login_token(html), "meta456")

    def test_prefers_hidden_login_token_when_both_exist(self) -> None:
        html = (
            '<input type="hidden" name="_token" value="form123">'
            '<meta name="csrf-token" content="meta456">'
        )

        self.assertEqual(parse_login_token(html), "form123")

    def test_formats_positive_and_negative_durations(self) -> None:
        self.assertEqual(format_duration(15120), "04:12:00")
        self.assertEqual(format_duration(-60), "-00:01:00")

    def test_summary_adds_the_active_work_event_to_accumulated_work(self) -> None:
        output = io.StringIO()
        data = {
            "currentWorkSeconds": 12600,
            "targetSeconds": 27720,
            "currentEvent": {
                "occuredAt": "2026-07-16T10:35:00.000000Z",
                "taskId": 10,
                "taskLabel": "Arbeitszeit",
            },
        }
        vienna = timezone(timedelta(hours=2))

        with redirect_stdout(output):
            print_summary(
                data,
                now=datetime(2026, 7, 16, 15, 52, 31, tzinfo=vienna),
            )

        self.assertIn("Worked:    06:47:31", output.getvalue())
        self.assertIn("Remaining: 00:54:29", output.getvalue())
        self.assertIn("Finished at: 16:47", output.getvalue())

    def test_resolves_site_by_name_or_id(self) -> None:
        data = {
            "sites": [
                {"id": 65630, "name": "Büro"},
                {"id": 65631, "name": "Homeoffice"},
            ]
        }

        self.assertEqual(resolve_site(data, "homeoffice"), ("65631", "Homeoffice"))
        self.assertEqual(resolve_site(data, "65630"), ("65630", "Büro"))

    def test_record_event_posts_the_clock_in_payload(self) -> None:
        client = ClockinClient()
        client.csrf_token = "csrf123"
        client.session = Mock()
        client.session.post.return_value.raise_for_status = Mock()

        client.record_event(10, "Arbeitszeit", "65631")

        _, kwargs = client.session.post.call_args
        self.assertEqual(
            kwargs["json"],
            {"taskId": 10, "taskLabel": "Arbeitszeit", "siteId": "65631"},
        )

    def test_record_event_posts_pause_and_clock_out_payloads(self) -> None:
        client = ClockinClient()
        client.csrf_token = "csrf123"
        client.session = Mock()
        client.session.post.return_value.raise_for_status = Mock()

        for task_id in (5, 8):
            with self.subTest(task_id=task_id):
                client.record_event(task_id)
                _, kwargs = client.session.post.call_args
                self.assertEqual(kwargs["json"], {"taskId": task_id})

    def test_busybar_state_distinguishes_work_break_and_off_duty(self) -> None:
        self.assertEqual(display_state({"targetSeconds": 27720}).mode, ClockMode.OFF)
        self.assertEqual(
            display_state(
                {"targetSeconds": 27720, "currentEvent": {"taskId": 10}}
            ).mode,
            ClockMode.WORKING,
        )
        self.assertEqual(
            display_state({"targetSeconds": 27720, "currentEvent": {"taskId": 5}}).mode,
            ClockMode.BREAK,
        )

    def test_busybar_state_tracks_elapsed_pause_time(self) -> None:
        now = datetime(2026, 7, 16, 15, 52, 31, tzinfo=timezone.utc)
        state = display_state(
            {
                "currentWorkSeconds": 12600,
                "targetSeconds": 27720,
                "currentEvent": {
                    "taskId": 5,
                    "occuredAt": "2026-07-16T15:50:00.000000Z",
                },
            },
            now=now,
        )

        self.assertEqual(state.mode, ClockMode.BREAK)
        self.assertEqual(state.worked_seconds, 12600)
        self.assertEqual(state.break_seconds, 151)

    def test_busybar_button_event_uses_the_configured_button(self) -> None:
        frame = {
            "updates": [
                {"input": {"button_event": {"button": "START", "action": "PRESS"}}}
            ]
        }

        self.assertEqual(button_event(frame, "START"), "PRESS")
        self.assertIsNone(button_event(frame, "OK"))


class BusyBarControllerTest(unittest.IsolatedAsyncioTestCase):
    async def test_renderer_fits_status_on_the_72_by_16_front_display(self) -> None:
        bar = Mock()
        bar.display_draw = AsyncMock()
        renderer = BusyBarRenderer(bar)

        await renderer.render(ClockDisplayState(ClockMode.WORKING, 24420, 27720))

        payload = bar.display_draw.await_args.args[0]
        self.assertEqual(len(payload.elements), 1)
        element = payload.elements[0]
        self.assertEqual(element.text, "06:47 WORK")
        self.assertEqual((element.x, element.y), (36, 8))
        self.assertEqual(element.align, "center")
        self.assertEqual(element.font, "condensed")

    async def test_renderer_clears_only_the_clockin_display_on_request(self) -> None:
        bar = Mock()
        bar.display_clear = AsyncMock()
        renderer = BusyBarRenderer(bar)

        await renderer.clear()

        bar.display_clear.assert_awaited_once_with(application_name="clockin")

    async def test_renderer_fits_feedback_on_the_front_display(self) -> None:
        bar = Mock()
        bar.display_draw = AsyncMock()
        renderer = BusyBarRenderer(bar)

        await renderer.feedback("CLOCK OUT", "#8ca5ff")

        payload = bar.display_draw.await_args.args[0]
        self.assertEqual(len(payload.elements), 1)
        element = payload.elements[0]
        self.assertEqual(element.text, "CLOCK OUT")
        self.assertEqual((element.x, element.y), (36, 8))
        self.assertEqual(element.id, "clockin-status")
        self.assertEqual(
            bar.display_draw.await_args.kwargs, {"clear_before_draw": False}
        )

    async def test_pause_refresh_replaces_pausing_feedback(self) -> None:
        bar = Mock()
        bar.display_draw = AsyncMock()
        states = iter(
            [
                ClockDisplayState(ClockMode.WORKING, 24420, 27720),
                ClockDisplayState(ClockMode.BREAK, 24420, 27720, break_seconds=2),
            ]
        )

        async def status() -> ClockDisplayState:
            return next(states)

        controller = BusyBarController(
            BusyBarConfig(host="busybar.local"),
            status=status,
            clock_in=AsyncMock(),
            pause=AsyncMock(),
            resume=AsyncMock(),
            clock_out=AsyncMock(),
        )
        controller._renderer = BusyBarRenderer(bar)

        await controller._toggle_pause()

        final_payload = bar.display_draw.await_args.args[0]
        self.assertEqual(final_payload.elements[0].text, "00:00 BREAK")
        self.assertEqual(
            [call.args[0].priority for call in bar.display_draw.await_args_list],
            [60, 60, 60],
        )

    async def test_renderer_updates_pause_duration_without_clearing(self) -> None:
        bar = Mock()
        bar.display_draw = AsyncMock()
        renderer = BusyBarRenderer(bar)

        await renderer.render(
            ClockDisplayState(ClockMode.BREAK, 24420, 27720, break_seconds=125)
        )

        payload = bar.display_draw.await_args.args[0]
        self.assertEqual(payload.elements[0].text, "00:02 BREAK")
        self.assertEqual(payload.elements[0].id, "clockin-status")
        self.assertEqual(
            bar.display_draw.await_args.kwargs, {"clear_before_draw": False}
        )

    async def test_renderer_ignores_a_lower_priority_display_conflict(self) -> None:
        bar = Mock()
        bar.display_draw = AsyncMock(
            side_effect=BusyBarAPIError(
                "Not drawn due to low priority", status_code=409
            )
        )
        renderer = BusyBarRenderer(bar)

        await renderer.render(ClockDisplayState(ClockMode.WORKING, 24420, 27720))

    async def test_controller_clears_on_start_and_cancel(self) -> None:
        bar = MagicMock()
        bar.display_clear = AsyncMock()
        bar.display_draw = AsyncMock()

        async def wait_for_shutdown():
            await asyncio.Event().wait()
            yield {}

        bar.stream_status_ws.return_value = wait_for_shutdown()
        busybar_context = MagicMock()
        busybar_context.__aenter__ = AsyncMock(return_value=bar)
        busybar_context.__aexit__ = AsyncMock(return_value=None)

        controller = BusyBarController(
            BusyBarConfig(host="busybar.local", poll_interval_seconds=3600),
            status=AsyncMock(return_value=ClockDisplayState(ClockMode.OFF, 0, 27720)),
            clock_in=AsyncMock(),
            pause=AsyncMock(),
            resume=AsyncMock(),
            clock_out=AsyncMock(),
        )

        with patch("busybar.AsyncBusyBar", return_value=busybar_context):
            task = asyncio.create_task(controller.run())
            while bar.display_clear.await_count < 1:
                await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertEqual(bar.display_clear.await_count, 2)
        busybar_context.__aexit__.assert_awaited_once()

    async def test_single_press_clocks_in_from_off_duty(self) -> None:
        recorded: list[str] = []

        async def status() -> ClockDisplayState:
            return ClockDisplayState(ClockMode.OFF, 0, 27720)

        async def clock_in() -> None:
            recorded.append("clock-in")

        controller = BusyBarController(
            BusyBarConfig(host="busybar.local"),
            status=status,
            clock_in=clock_in,
            pause=AsyncMock(),
            resume=AsyncMock(),
            clock_out=AsyncMock(),
        )
        controller._renderer = Mock()
        controller._renderer.feedback = AsyncMock()
        controller._renderer.render = AsyncMock()

        await controller._toggle_pause()

        self.assertEqual(recorded, ["clock-in"])


if __name__ == "__main__":
    unittest.main()
