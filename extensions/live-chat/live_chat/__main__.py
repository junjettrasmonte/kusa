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
    if not cfg.strata_base_url:
        print(
            "warning: STRATA_BASE_URL is empty — LLM turns will fail until set",
            file=sys.stderr,
        )
    run(cfg)


if __name__ == "__main__":
    main()
