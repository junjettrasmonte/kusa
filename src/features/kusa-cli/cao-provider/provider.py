"""Kusă CLI provider for CLI Agent Orchestrator (CAO).

Wraps ``kusa agent`` — an interactive REPL with stable markers:

- Idle prompt: ``kusa❯ ``
- Response: lines starting with ``⏺ ``
- Processing: ``… thinking``
- Errors: ``ERROR: ``
- Exit: ``/exit``

Optional CAO integration for the standalone ``kusa agent`` REPL.
Installed by ``src/features/kusa-cli/cao-provider/install.mjs``.
"""

from __future__ import annotations

import logging
import re
import shlex
from typing import List, Optional

from cli_agent_orchestrator.backends.registry import get_backend
from cli_agent_orchestrator.models.agent_profile import AgentProfile
from cli_agent_orchestrator.models.terminal import TerminalStatus
from cli_agent_orchestrator.providers.base import BaseProvider
from cli_agent_orchestrator.utils.terminal import wait_for_shell, wait_until_status

logger = logging.getLogger(__name__)

ANSI_CODE_PATTERN = r"\x1b\[[0-9;]*m"
IDLE_PROMPT_PATTERN = r"kusa❯\s*$"
IDLE_PROMPT_PATTERN_LOG = r"kusa❯\s"
RESPONSE_INDICATOR_PATTERN = r"^⏺\s+"
PROCESSING_PATTERN = r"…\s*thinking"
ERROR_INDICATOR = "ERROR: "


class KusaCliProvider(BaseProvider):
    """Drive the Kusă agent REPL inside a CAO tmux terminal."""

    BINARY_NAME = "kusa"

    @classmethod
    def honors_model(
        cls,
        agent_profile: Optional[str],
        profile: Optional["AgentProfile"],
        requested_model: Optional[str],
    ) -> bool:
        return bool(requested_model)

    def __init__(
        self,
        terminal_id: str,
        session_name: str,
        window_name: str,
        agent_profile: Optional[str] = None,
        allowed_tools: Optional[List[str]] = None,
        skill_prompt: Optional[str] = None,
        model: Optional[str] = None,
    ) -> None:
        super().__init__(
            terminal_id,
            session_name,
            window_name,
            allowed_tools,
            skill_prompt=skill_prompt,
        )
        self._agent_profile = agent_profile
        self._model = model

    @property
    def paste_enter_count(self) -> int:
        # Line-oriented readline: one Enter after paste submits the line.
        return 1

    async def initialize(self) -> bool:
        if not await wait_for_shell(self.terminal_id, timeout=10.0):
            raise TimeoutError("Shell initialization timed out after 10 seconds")

        argv = [self.BINARY_NAME, "agent"]
        if self._model:
            argv.extend(["--model", str(self._model)])
        command = shlex.join(argv)
        logger.info("Launching Kusă agent: %s", command)
        get_backend().send_keys(self.session_name, self.window_name, command)

        if not await wait_until_status(
            self.terminal_id,
            {TerminalStatus.IDLE, TerminalStatus.COMPLETED},
            timeout=30.0,
        ):
            raise TimeoutError("kusa agent initialization timed out after 30 seconds")

        self._initialized = True
        return True

    def get_status(self, buffer: str) -> TerminalStatus:
        native = self._resolve_native_status(buffer)
        if native is not None:
            return native

        buffer = self._resolve_buffer(buffer)
        if not buffer:
            return TerminalStatus.UNKNOWN

        clean = re.sub(ANSI_CODE_PATTERN, "", buffer)

        if ERROR_INDICATOR in clean and not re.search(IDLE_PROMPT_PATTERN, clean, re.MULTILINE):
            # Only ERROR while still processing; once idle returns, prefer IDLE/COMPLETED.
            if re.search(PROCESSING_PATTERN, clean):
                return TerminalStatus.ERROR

        has_idle = re.search(IDLE_PROMPT_PATTERN, clean, re.MULTILINE)
        if not has_idle:
            if re.search(PROCESSING_PATTERN, clean) or ERROR_INDICATOR in clean:
                return TerminalStatus.PROCESSING
            return TerminalStatus.PROCESSING

        responses = list(re.finditer(RESPONSE_INDICATOR_PATTERN, clean, re.MULTILINE))
        if responses:
            return TerminalStatus.COMPLETED
        return TerminalStatus.IDLE

    def extract_last_message_from_script(self, script_output: str) -> str:
        clean = re.sub(ANSI_CODE_PATTERN, "", script_output)
        matches = list(re.finditer(r"^⏺\s+(.*)$", clean, re.MULTILINE))
        if not matches:
            raise ValueError("No Kusă agent response found in script output")
        # Capture from the last marker through the next idle prompt (or EOF).
        last = matches[-1]
        start = last.start()
        rest = clean[start:]
        # Drop the marker itself for the returned body.
        body = rest[len(last.group(0)) - len(last.group(1)) :]
        # Trim anything after a subsequent idle prompt line.
        idle = re.search(r"\nkusa❯\s*$", body, re.MULTILINE)
        if idle:
            body = body[: idle.start()]
        # If the match was a single-line reply, group(1) is enough.
        if "\n" not in body.strip():
            return last.group(1).strip()
        # Multi-line: first line is group(1), remainder follows.
        first = last.group(1)
        remainder = clean[last.end() :]
        idle2 = re.search(r"\nkusa❯\s*$", remainder, re.MULTILINE)
        if idle2:
            remainder = remainder[: idle2.start()]
        text = (first + remainder).strip()
        return text

    def get_idle_pattern_for_log(self) -> str:
        return IDLE_PROMPT_PATTERN_LOG

    def exit_cli(self) -> str:
        return "/exit"

    def cleanup(self) -> None:
        return None
