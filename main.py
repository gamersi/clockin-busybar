#!/usr/bin/env python3
"""Small, unofficial client for the clockin.de employee web interface."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from busylib.exceptions import BusyBarError

from busybar import BusyBarConfig, BusyBarController, ClockDisplayState, ClockMode


DEFAULT_BASE_URL = "https://office.clockin.de"
CLOCK_OUT_TASK_ID = 8
PAUSE_TASK_ID = 5
WORK_TASK_ID = 10
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)


def default_config_path() -> str:
    """Return the per-user configuration path following the XDG convention."""
    config_home = os.getenv("XDG_CONFIG_HOME")
    if config_home:
        return os.path.join(config_home, "clockin", "config.json")
    return os.path.join(os.path.expanduser("~"), ".config", "clockin", "config.json")


def load_config(path: str) -> dict[str, str]:
    """Load saved settings without requiring a config file to exist."""
    try:
        with open(path, encoding="utf-8") as config_file:
            raw_config = json.load(config_file)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Could not parse saved configuration at {path}: {exc}"
        ) from exc
    except OSError as exc:
        raise RuntimeError(
            f"Could not read saved configuration at {path}: {exc}"
        ) from exc

    if not isinstance(raw_config, dict):
        raise RuntimeError(f"Saved configuration at {path} must be a JSON object")
    return {key: value for key, value in raw_config.items() if isinstance(value, str)}


def save_config(path: str, config: dict[str, str]) -> None:
    """Atomically save config in a directory and file accessible only to its owner."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=".config-", dir=directory, text=True
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as config_file:
            json.dump(config, config_file, indent=2)
            config_file.write("\n")
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, path)
    except OSError:
        try:
            os.unlink(temporary_path)
        except OSError:
            pass
        raise


def clear_config(path: str) -> bool:
    try:
        os.unlink(path)
    except FileNotFoundError:
        return False
    return True


def first_value(*values: str | None) -> str | None:
    return next((value for value in values if value), None)


class TokenParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.form_token: str | None = None
        self.csrf_token: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "input" and values.get("name") == "_token":
            self.form_token = values.get("value")
        elif tag == "meta" and values.get("name") == "csrf-token":
            self.csrf_token = values.get("content")


def parse_tokens(html: str) -> TokenParser:
    parser = TokenParser()
    parser.feed(html)
    return parser


def parse_login_token(html: str) -> str | None:
    tokens = parse_tokens(html)
    return tokens.form_token or tokens.csrf_token


class ClockinClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept-Language": "de-AT,de;q=0.9",
                "User-Agent": USER_AGENT,
            }
        )
        self.csrf_token: str | None = None

    def url(self, path: str) -> str:
        return urljoin(self.base_url, path.lstrip("/"))

    def login(self, email: str, password: str) -> None:
        login_url = self.url("login")
        response = self.session.get(
            login_url,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            timeout=30,
        )
        response.raise_for_status()

        form_token = parse_login_token(response.text)
        if not form_token:
            raise RuntimeError(
                "The login page contained neither an _token input nor a csrf-token meta tag"
            )

        response = self.session.post(
            login_url,
            data={"_token": form_token, "email": email, "password": password},
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Origin": self.base_url.rstrip("/"),
                "Referer": login_url,
            },
            timeout=30,
        )
        response.raise_for_status()

        if urlparse(response.url).path.rstrip("/") == "/login":
            raise RuntimeError("Login failed; check the email address and password")

        self.csrf_token = parse_tokens(response.text).csrf_token
        if not self.csrf_token:
            dashboard_url = self.url("dashboard")
            response = self.session.get(
                dashboard_url,
                headers={"Accept": "text/html", "Referer": login_url},
                timeout=30,
            )
            response.raise_for_status()
            self.csrf_token = parse_tokens(response.text).csrf_token

        if not self.csrf_token:
            raise RuntimeError(
                "The dashboard did not contain the expected csrf-token meta tag"
            )

    def clock_data(self) -> dict[str, Any]:
        if not self.csrf_token:
            raise RuntimeError("Call login() before clock_data()")

        response = self.session.get(
            self.url("clock/data"),
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Referer": self.url("dashboard"),
                "X-CSRF-TOKEN": self.csrf_token,
            },
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError(
                "Unexpected /clock/data response: expected a JSON object"
            )
        return data

    def record_event(
        self,
        task_id: int,
        task_label: str | None = None,
        site_id: str | None = None,
    ) -> None:
        if not self.csrf_token:
            raise RuntimeError("Call login() before record_event()")

        payload: dict[str, Any] = {"taskId": task_id}
        if task_label is not None:
            payload["taskLabel"] = task_label
        if site_id is not None:
            payload["siteId"] = site_id

        response = self.session.post(
            self.url("clock/recordEvent"),
            json=payload,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": self.base_url.rstrip("/"),
                "Referer": self.url("dashboard"),
                "X-CSRF-TOKEN": self.csrf_token,
            },
            timeout=30,
        )
        response.raise_for_status()


def format_duration(value: int) -> str:
    sign = "-" if value < 0 else ""
    hours, remainder = divmod(abs(value), 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{sign}{hours:02d}:{minutes:02d}:{seconds:02d}"


def calculate_event_seconds(
    data: dict[str, Any], task_id: int, now: datetime | None = None
) -> int:
    """Return the elapsed time for the active event when it matches a task."""
    event = data.get("currentEvent")
    if not isinstance(event, dict) or event.get("taskId") != task_id:
        return 0

    occurred_at = event.get("occuredAt") or event.get("occurredAt")
    if not isinstance(occurred_at, str):
        return 0

    try:
        started_at = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    except ValueError:
        return 0

    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    current_time = now or datetime.now().astimezone()
    if current_time.tzinfo is None:
        current_time = current_time.astimezone()

    return max(0, int((current_time - started_at).total_seconds()))


def calculate_worked_seconds(data: dict[str, Any], now: datetime | None = None) -> int:
    worked = int(data.get("currentWorkSeconds") or 0)
    active_seconds = calculate_event_seconds(data, WORK_TASK_ID, now)
    return worked + active_seconds


def print_summary(data: dict[str, Any], now: datetime | None = None) -> None:
    local_now = now or datetime.now().astimezone()
    worked = calculate_worked_seconds(data, local_now)
    target = int(data.get("targetSeconds") or 0)
    remaining = target - worked
    event = data.get("currentEvent")

    print(f"Worked:    {format_duration(worked)}")
    print(f"Target:    {format_duration(target)}")
    if remaining >= 0:
        print(f"Remaining: {format_duration(remaining)}")
        if (
            remaining > 0
            and isinstance(event, dict)
            and event.get("taskId") == WORK_TASK_ID
        ):
            finished_at = local_now + timedelta(seconds=remaining)
            print(f"Finished at: {finished_at:%H:%M}")
    else:
        print(f"Overtime:  {format_duration(-remaining)}")

    if isinstance(event, dict):
        site = event.get("site")
        site_name = site.get("name") if isinstance(site, dict) else None
        details = [str(value) for value in (event.get("taskLabel"), site_name) if value]
        if details:
            print(f"Current:   {' / '.join(details)}")
        if event.get("occuredAt"):
            print(f"Since:     {event['occuredAt']}")
    else:
        print("Current:   not clocked in")


def task_label(data: dict[str, Any], task_id: int, fallback: str) -> str:
    tasks = data.get("tasks")
    if isinstance(tasks, list):
        for task in tasks:
            if isinstance(task, dict) and task.get("taskId") == task_id:
                name = task.get("name")
                if isinstance(name, str) and name:
                    return name
    return fallback


def resolve_site(data: dict[str, Any], selection: str | None) -> tuple[str, str]:
    raw_sites = data.get("sites")
    sites = (
        [site for site in raw_sites if isinstance(site, dict)]
        if isinstance(raw_sites, list)
        else []
    )

    if selection is None and len(sites) == 1:
        site = sites[0]
        return str(site.get("id")), str(site.get("name") or site.get("id"))

    if selection is not None:
        wanted = selection.strip().casefold()
        for site in sites:
            site_id = str(site.get("id"))
            site_name = str(site.get("name") or "")
            if wanted in (site_id.casefold(), site_name.casefold()):
                return site_id, site_name or site_id

    available = (
        ", ".join(f"{site.get('name')} ({site.get('id')})" for site in sites) or "none"
    )
    if selection is None:
        raise RuntimeError(f"Clock-in requires --site. Available sites: {available}")
    raise RuntimeError(f"Unknown site {selection!r}. Available sites: {available}")


def display_state(
    data: dict[str, Any], now: datetime | None = None
) -> ClockDisplayState:
    event = data.get("currentEvent")
    task_id = event.get("taskId") if isinstance(event, dict) else None
    if event is None:
        mode = ClockMode.OFF
    elif task_id == WORK_TASK_ID:
        mode = ClockMode.WORKING
    elif task_id == PAUSE_TASK_ID:
        mode = ClockMode.BREAK
    else:
        mode = ClockMode.OTHER

    site = event.get("site") if isinstance(event, dict) else None
    site_name = site.get("name") if isinstance(site, dict) else None
    label = event.get("taskLabel") if isinstance(event, dict) else None
    return ClockDisplayState(
        mode=mode,
        worked_seconds=calculate_worked_seconds(data, now),
        target_seconds=int(data.get("targetSeconds") or 0),
        label=str(label) if label else None,
        site=str(site_name) if site_name else None,
        break_seconds=calculate_event_seconds(data, PAUSE_TASK_ID, now),
    )


def run_busybar(client: ClockinClient, args: argparse.Namespace) -> None:
    async def status() -> ClockDisplayState:
        data = await asyncio.to_thread(client.clock_data)
        return display_state(data)

    async def pause() -> None:
        await asyncio.to_thread(client.record_event, PAUSE_TASK_ID)

    async def clock_in() -> None:
        data = await asyncio.to_thread(client.clock_data)
        site_id, _ = resolve_site(data, args.site)
        await asyncio.to_thread(
            client.record_event,
            WORK_TASK_ID,
            task_label(data, WORK_TASK_ID, "Arbeitszeit"),
            site_id,
        )

    async def resume() -> None:
        await clock_in()

    async def clock_out() -> None:
        await asyncio.to_thread(client.record_event, CLOCK_OUT_TASK_ID)

    controller = BusyBarController(
        config=BusyBarConfig(
            host=args.busybar_host,
            token=args.busybar_token,
            button=args.busybar_button,
            poll_interval_seconds=args.busybar_poll_interval,
        ),
        status=status,
        clock_in=clock_in,
        pause=pause,
        resume=resume,
        clock_out=clock_out,
    )
    asyncio.run(controller.run())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Log in to office.clockin.de and fetch /clock/data."
    )
    parser.add_argument(
        "action",
        nargs="?",
        default="status",
        choices=("status", "clock-in", "pause", "clock-out", "busybar", "configure"),
    )
    parser.add_argument("--email", help="clockin.de email address")
    parser.add_argument(
        "--site",
        help="site ID or name for clock-in",
    )
    parser.add_argument(
        "--busybar-host",
        help="BUSY Bar IP address or USB address",
    )
    parser.add_argument(
        "--busybar-token",
        help="BUSY Bar Wi-Fi/cloud token",
    )
    parser.add_argument(
        "--busybar-button",
        help="physical button to use: START, OK, or BACK",
    )
    parser.add_argument("--busybar-poll-interval", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--base-url", help=argparse.SUPPRESS)
    parser.add_argument(
        "--config-file",
        default=default_config_path(),
        help="path to the local configuration file",
    )
    parser.add_argument(
        "--save-credentials",
        action="store_true",
        help="save the clockin.de email and password after a successful login",
    )
    parser.add_argument(
        "--clear-credentials",
        action="store_true",
        help="delete the saved local configuration and exit",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print the complete JSON response instead of a summary",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        if args.clear_credentials:
            if clear_config(args.config_file):
                print(f"Deleted saved configuration: {args.config_file}")
            else:
                print("No saved configuration found.")
            return 0

        config = load_config(args.config_file)
        args.site = first_value(
            args.site, os.getenv("CLOCKIN_SITE"), config.get("site")
        )
        args.busybar_host = first_value(
            args.busybar_host,
            os.getenv("BUSYBAR_HOST"),
            config.get("busybar_host"),
            "10.0.4.20",
        )
        args.busybar_token = first_value(
            args.busybar_token, os.getenv("BUSYBAR_TOKEN"), config.get("busybar_token")
        )
        args.busybar_button = first_value(
            args.busybar_button,
            os.getenv("BUSYBAR_BUTTON"),
            config.get("busybar_button"),
            "START",
        )
        args.busybar_poll_interval = args.busybar_poll_interval or float(
            os.getenv("BUSYBAR_POLL_INTERVAL", "15")
        )
        args.base_url = (
            first_value(args.base_url, os.getenv("CLOCKIN_BASE_URL"), DEFAULT_BASE_URL)
            or DEFAULT_BASE_URL
        )
        email = first_value(args.email, os.getenv("CLOCKIN_EMAIL"), config.get("email"))

        if args.action == "configure":
            email = email or input("Email: ").strip()
            password = os.getenv("CLOCKIN_PASSWORD") or getpass.getpass("Password: ")
            if not email or not password:
                raise RuntimeError("Email and password are required")
            config.update({"email": email, "password": password})
            if args.site:
                config["site"] = args.site
            if args.busybar_token:
                config["busybar_token"] = args.busybar_token
            save_config(args.config_file, config)
            print(f"Saved configuration: {args.config_file}")
            return 0

        email = email or input("Email: ").strip()
        password = first_value(os.getenv("CLOCKIN_PASSWORD"), config.get("password"))
        password = password or getpass.getpass("Password: ")
        if not email or not password:
            raise RuntimeError("Email and password are required")

        client = ClockinClient(args.base_url)
        client.login(email, password)
        if args.save_credentials:
            config.update({"email": email, "password": password})
            save_config(args.config_file, config)
            print(f"Saved credentials: {args.config_file}")
        data = client.clock_data()

        if args.action == "busybar":
            resolve_site(data, args.site)
            run_busybar(client, args)
            return 0
        if args.action == "clock-in":
            site_id, site_name = resolve_site(data, args.site)
            client.record_event(
                WORK_TASK_ID,
                task_label(data, WORK_TASK_ID, "Arbeitszeit"),
                site_id,
            )
            print(f"Clocked in: {site_name}\n")
            data = client.clock_data()
        elif args.action == "pause":
            client.record_event(PAUSE_TASK_ID)
            print("Paused\n")
            data = client.clock_data()
        elif args.action == "clock-out":
            client.record_event(CLOCK_OUT_TASK_ID)
            print("Clocked out\n")
            data = client.clock_data()
    except (
        requests.RequestException,
        RuntimeError,
        ValueError,
        BusyBarError,
        OSError,
    ) as exc:
        print(f"clockin client error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print_summary(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
