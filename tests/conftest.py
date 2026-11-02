import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

LINKEDIN = Path(__file__).resolve().parent.parent / "linkedin"
if str(LINKEDIN) not in sys.path:
    sys.path.insert(0, str(LINKEDIN))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
