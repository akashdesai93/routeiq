# The phone lab's line to the iPhone (docs/phone-lab.md). run.mjs starts this once per scenario,
# with the Python of the pymobiledevice3 environment (docs/phone-sim-location.md), and sends it
# one JSON command per line; it answers each with one JSON line.
#
# Why one long-lived process: on iOS 17 and later every developer command needs a tunnel to the
# phone, and the simulated position lasts only as long as the connection that set it. Separate
# commands each bring their own tunnel and the position falls back to the real GPS in between.
# Here one tunnel and one connection carry everything: the simulated position, starting apps,
# screenshots, CPU samples and reading the screen.
#
# It never prints the phone's identifiers, and it reads the screen only as text for run.mjs.
import asyncio
import json
import sys
from contextlib import AsyncExitStack

from pymobiledevice3.remote import userspace_tunnel
from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.dvt.instruments.process_control import ProcessControl
from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot
from pymobiledevice3.services.dvt.instruments.sysmontap import Sysmontap

CAPTION_LIMIT = 400


def look(png: bytes):
    """
    How much of the screen below the status bar and a banner's height is one flat colour: the share of pixels within
    a few shades of the commonest brightness, and that brightness (0 black, 255 white). A screen
    that was never painted is all one colour. None when Pillow is not installed.
    """
    try:
        import io

        from PIL import Image
    except ImportError:
        return None
    image = Image.open(io.BytesIO(png)).convert("L")
    width, height = image.size
    # From 20 % down: below the status bar and below a notification banner, which would
    # otherwise count a black screen with a banner over it as drawn (#136).
    body = image.crop((0, int(height * 0.2), width, height)).resize((90, 180))
    histogram = body.histogram()
    commonest = max(range(256), key=lambda shade: histogram[shade])
    near = sum(histogram[max(0, commonest - 6) : commonest + 7])
    return {"flat": round(near / (90 * 180), 4), "shade": commonest}


async def captions(rsd) -> list[str]:
    """One caption per element of the app in front, as a screen reader finds them. Empty when the phone is locked."""
    found: list[str] = []
    try:
        async with AccessibilityAudit(rsd) as service:
            async for element in service.iter_elements():
                found.append(element.caption or "")
                if len(found) >= CAPTION_LIMIT:
                    break
    except TimeoutError:
        pass
    return found


async def processes(dvt, names: list[str]) -> dict:
    """CPU (share of one core, in percent) and memory of the processes with these names, summed per name."""
    out: dict = {}
    async with await Sysmontap.create(dvt) as sysmon:
        seen = 0
        async for snapshot in sysmon.iter_processes():
            seen += 1
            # The first snapshot has no CPU figures yet.
            if seen < 2:
                continue
            for name in names:
                matching = [p for p in snapshot if p.get("name") == name]
                if matching:
                    out[name] = {
                        "processes": len(matching),
                        "cpuPercent": round(sum(p.get("cpuUsage") or 0 for p in matching), 1),
                        "memoryMb": round(sum(p.get("physFootprint") or p.get("memResidentSize") or 0 for p in matching) / 1e6),
                    }
            break
    return out


async def handle(command: dict, rsd, dvt, location, control, screenshot) -> dict:
    what = command.get("cmd")
    if what == "location":
        await location.set(float(command["lat"]), float(command["lng"]))
        return {}
    if what == "clear":
        await location.clear()
        return {}
    if what == "launch":
        pid = await control.launch(
            bundle_id=command["bundle"],
            arguments=list(command.get("args") or []),
            kill_existing=not command.get("keep", False),
        )
        return {"pid": int(pid)}
    if what == "screenshot":
        png = await screenshot.get_screenshot()
        with open(command["file"], "wb") as out:
            out.write(png)
        return {"look": look(png)}
    if what == "captions":
        return {"captions": await captions(rsd)}
    if what == "processes":
        return {"processes": await asyncio.wait_for(processes(dvt, list(command["names"])), 20)}
    if what == "ping":
        return {}
    raise ValueError("unknown command")


async def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    loop = asyncio.get_running_loop()
    rsd = await userspace_tunnel.establish_userspace_rsd()
    async with AsyncExitStack() as stack:
        dvt = await stack.enter_async_context(DvtProvider(rsd))
        location = await stack.enter_async_context(LocationSimulation(dvt))
        control = await stack.enter_async_context(ProcessControl(dvt))
        screenshot = await stack.enter_async_context(Screenshot(dvt))
        print(json.dumps({"ready": True}), flush=True)
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            try:
                command = json.loads(line)
            except ValueError:
                continue
            if command.get("cmd") == "quit":
                break
            try:
                answer = await asyncio.wait_for(handle(command, rsd, dvt, location, control, screenshot), 60)
                answer.update({"id": command.get("id"), "ok": True})
            except Exception as error:  # every failure goes back as a word, never as a traceback with identifiers
                answer = {"id": command.get("id"), "ok": False, "error": type(error).__name__}
            print(json.dumps(answer, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
