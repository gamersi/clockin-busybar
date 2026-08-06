"""BUSY Bar display and button controller for the Clockin client."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from time import monotonic
from typing import Any

from busylib import AsyncBusyBar, types
from busylib.exceptions import BusyBarAPIError


logger = logging.getLogger(__name__)


class ClockMode(StrEnum):
    OFF = "off"
    WORKING = "working"
    BREAK = "break"
    OTHER = "other"


@dataclass(frozen=True)
class ClockDisplayState:
    mode: ClockMode
    worked_seconds: int
    target_seconds: int
    label: str | None = None
    site: str | None = None
    break_seconds: int = 0


@dataclass(frozen=True)
class BusyBarConfig:
    host: str
    token: str | None = None
    button: str = "START"
    poll_interval_seconds: float = 15.0
    double_press_window_seconds: float = 0.45
    long_press_seconds: float = 1.2


def format_compact_duration(seconds: int) -> str:
    hours, remainder = divmod(max(0, seconds), 3600)
    minutes, _ = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}"


def button_event(frame: dict[str, Any], button: str) -> str | None:
    """Return PRESS or RELEASE for the configured physical button.

    PRESS is the protobuf enum's default value, so the BUSY Bar omits the
    action field for press events.
    """
    updates = frame.get("updates")
    if not isinstance(updates, list):
        return None

    for update in updates:
        if not isinstance(update, dict):
            continue
        input_update = update.get("input")
        if not isinstance(input_update, dict):
            continue
        event = input_update.get("button_event") or input_update.get("buttonEvent")
        if not isinstance(event, dict):
            continue
        if str(event.get("button", "")).upper() != button.upper():
            continue
        raw_action = event.get("action")
        action = "PRESS" if raw_action is None else str(raw_action).upper()
        if action in {"PRESS", "RELEASE"}:
            return action
    return None


class BusyBarRenderer:
    APPLICATION_NAME = "clockin"
    STATUS_ELEMENT_ID = "clockin-status"
    DISPLAY_PRIORITY = 60
    # The user-facing RGB matrix is 72 pixels wide and 16 pixels high.
    FRONT_CENTER_X = 36
    FRONT_CENTER_Y = 8

    def __init__(self, bar: AsyncBusyBar) -> None:
        self.bar = bar

    async def clear(self) -> None:
        """Clear this app's display elements without affecting other apps."""
        await self.bar.display_clear(application_name=self.APPLICATION_NAME)

    async def render(self, state: ClockDisplayState) -> None:
        text, color = self._content(state)
        elements = [
            types.TextElement(
                id=self.STATUS_ELEMENT_ID,
                type="text",
                x=self.FRONT_CENTER_X,
                y=self.FRONT_CENTER_Y,
                text=text,
                font="condensed",
                align="center",
                color=color,
            ),
        ]
        await self._draw(
            types.DisplayElements(
                application_name=self.APPLICATION_NAME,
                priority=self.DISPLAY_PRIORITY,
                elements=elements,
            ),
            clear_before_draw=False,
        )

    async def feedback(self, text: str, color: str) -> None:
        elements = [
            types.TextElement(
                id=self.STATUS_ELEMENT_ID,
                type="text",
                x=self.FRONT_CENTER_X,
                y=self.FRONT_CENTER_Y,
                text=text,
                font="condensed",
                align="center",
                color=color,
                timeout=2000,
            ),
        ]
        await self._draw(
            types.DisplayElements(
                application_name=self.APPLICATION_NAME,
                priority=self.DISPLAY_PRIORITY,
                elements=elements,
            ),
            clear_before_draw=False,
        )

    async def _draw(
        self, payload: types.DisplayElements, *, clear_before_draw: bool
    ) -> None:
        try:
            await self.bar.display_draw(
                payload,
                clear_before_draw=clear_before_draw,
            )
        except BusyBarAPIError as exc:
            if not self._is_low_priority_error(exc):
                raise
            logger.warning(
                "BUSY Bar display is owned by a higher-priority app: %s", exc
            )

    @staticmethod
    def _is_low_priority_error(error: BusyBarAPIError) -> bool:
        message = " ".join(
            str(value) for value in (error.error, error.response_excerpt) if value
        ).casefold()
        return (
            error.status_code == 409 or error.code == 409
        ) and "low priority" in message

    @staticmethod
    def _content(state: ClockDisplayState) -> tuple[str, str]:
        worked = format_compact_duration(state.worked_seconds)
        if state.mode is ClockMode.WORKING:
            return f"{worked} WORK", "#35d07f"
        if state.mode is ClockMode.BREAK:
            paused = format_compact_duration(state.break_seconds)
            return f"{paused} BREAK", "#f5b642"
        if state.mode is ClockMode.OFF:
            return "OFF DUTY", "#f06a6a"
        return "TRACKING", "#8ca5ff"


class BusyBarController:
    """Coordinates display refreshes and button gestures without overlapping actions."""

    def __init__(
        self,
        config: BusyBarConfig,
        status: Callable[[], Awaitable[ClockDisplayState]],
        clock_in: Callable[[], Awaitable[None]],
        pause: Callable[[], Awaitable[None]],
        resume: Callable[[], Awaitable[None]],
        clock_out: Callable[[], Awaitable[None]],
    ) -> None:
        self.config = config
        self.status = status
        self.clock_in = clock_in
        self.pause = pause
        self.resume = resume
        self.clock_out = clock_out
        self._state = ClockDisplayState(ClockMode.OFF, 0, 0)
        self._pressed_at: float | None = None
        self._pending_short_press: asyncio.Task[None] | None = None
        self._long_press_task: asyncio.Task[None] | None = None
        self._long_press_triggered = False
        self._action_lock = asyncio.Lock()

    async def run(self) -> None:
        async with AsyncBusyBar(self.config.host, token=self.config.token) as bar:
            self._renderer = BusyBarRenderer(bar)
            try:
                await self._renderer.clear()
                await self._refresh()
                await asyncio.gather(self._poll_loop(), self._input_loop(bar))
            finally:
                # asyncio.run() cancels this task on Ctrl-C, so finally runs
                # before the BUSY Bar connection is closed.
                await self._renderer.clear()

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self.config.poll_interval_seconds)
            async with self._action_lock:
                await self._refresh()

    async def _input_loop(self, bar: AsyncBusyBar) -> None:
        async for frame in bar.stream_status_ws():
            if not isinstance(frame, dict):
                continue
            action = button_event(frame, self.config.button)
            if action == "PRESS":
                self._pressed()
            elif action == "RELEASE":
                await self._released()
        raise RuntimeError("BUSY Bar status stream ended")

    def _pressed(self) -> None:
        if self._pressed_at is not None:
            return

        self._pressed_at = monotonic()
        self._long_press_triggered = False
        self._cancel_long_press()
        self._long_press_task = asyncio.create_task(self._delayed_long_press())

    async def _released(self) -> None:
        if self._pressed_at is None:
            return

        held_for = monotonic() - self._pressed_at
        self._pressed_at = None
        if self._long_press_triggered:
            return
        self._cancel_long_press()
        if held_for >= self.config.long_press_seconds:
            self._cancel_pending_short_press()
            await self._clock_out()
            return

        if self._pending_short_press and not self._pending_short_press.done():
            self._cancel_pending_short_press()
            await self._clock_out()
            return

        self._pending_short_press = asyncio.create_task(self._delayed_short_press())

    async def _delayed_long_press(self) -> None:
        try:
            await asyncio.sleep(self.config.long_press_seconds)
            if self._pressed_at is None or self._long_press_triggered:
                return
            self._long_press_triggered = True
            self._cancel_pending_short_press()
            await self._clock_out()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("BUSY Bar long-press action failed")

    async def _delayed_short_press(self) -> None:
        await asyncio.sleep(self.config.double_press_window_seconds)
        try:
            await self._toggle_pause()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("BUSY Bar short-press action failed")

    def _cancel_pending_short_press(self) -> None:
        if self._pending_short_press and not self._pending_short_press.done():
            self._pending_short_press.cancel()
        self._pending_short_press = None

    def _cancel_long_press(self) -> None:
        if self._long_press_task and not self._long_press_task.done():
            self._long_press_task.cancel()
        self._long_press_task = None

    async def _toggle_pause(self) -> None:
        async with self._action_lock:
            await self._refresh()
            if self._state.mode is ClockMode.WORKING:
                await self._renderer.feedback("PAUSING", "#f5b642")
                await self.pause()
            elif self._state.mode is ClockMode.BREAK:
                await self._renderer.feedback("RESUMING", "#35d07f")
                await self.resume()
            elif self._state.mode is ClockMode.OFF:
                await self._renderer.feedback("CLOCK IN", "#35d07f")
                await self.clock_in()
            else:
                await self._renderer.feedback("NO ACTION", "#8ca5ff")
                return
            await self._refresh()

    async def _clock_out(self) -> None:
        async with self._action_lock:
            await self._refresh()
            if self._state.mode is ClockMode.OFF:
                await self._renderer.feedback("OFF DUTY", "#f06a6a")
                return
            await self._renderer.feedback("CLOCK OUT", "#8ca5ff")
            await self.clock_out()
            await self._refresh()

    async def _refresh(self) -> None:
        self._state = await self.status()
        await self._renderer.render(self._state)
