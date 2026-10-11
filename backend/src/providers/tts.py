"""Natural speech for ride alerts: Microsoft neural voices through the edge-tts
Python library (en-IN Neerja, hi-IN Swara). Needs a connection; the app falls
back to the phone's built-in voice whenever this is unavailable or slow.

Phrases repeat a lot ("Pothole ahead, 20 metres"), so audio is cached in memory.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict

from providers.external import ProviderError

VOICES = {"en": "en-IN-NeerjaNeural", "hi": "hi-IN-SwaraNeural"}
MAX_CHARS = 300
_cache: OrderedDict[tuple[str, str], bytes] = OrderedDict()
_CACHE_SIZE = 300


def synth(text: str, lang: str = "en", timeout: float = 6.0) -> bytes:
    """MP3 bytes for text. Raises ProviderError (library missing, offline, timeout)."""
    key = (lang, text)
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    try:
        import edge_tts
    except ImportError as exc:
        raise ProviderError("edge-tts not installed") from exc

    async def run() -> bytes:
        audio = bytearray()
        async for chunk in edge_tts.Communicate(text, VOICES.get(lang, VOICES["en"]), rate="+8%").stream():
            if chunk["type"] == "audio":
                audio += chunk["data"]
        return bytes(audio)

    try:
        data = asyncio.run(asyncio.wait_for(run(), timeout))
    except Exception as exc:  # network, service or timeout: the caller falls back
        raise ProviderError(f"tts: {type(exc).__name__}: {exc}") from exc
    if not data:
        raise ProviderError("tts: empty audio")
    _cache[key] = data
    if len(_cache) > _CACHE_SIZE:
        _cache.popitem(last=False)
    return data
