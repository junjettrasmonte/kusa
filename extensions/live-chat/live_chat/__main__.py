"""CLI entry: `uv run python -m live_chat` or `kusa-live-chat`."""

from __future__ import annotations

import logging
import sys


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    from .config import LiveChatConfig
    from .server import run

    cfg = LiveChatConfig.from_env()
    if not cfg.llm_base_url:
        print(
            "warning: LLM_BASE_URL is empty — set the Kusă agent endpoint (any OpenAI-compatible provider)",
            file=sys.stderr,
        )
    run(cfg)


if __name__ == "__main__":
    main()
