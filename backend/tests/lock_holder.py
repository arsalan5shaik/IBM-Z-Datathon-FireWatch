"""Keep the spawned lock holder independent of expensive API/test imports."""

from app.persistence.atomic import single_owner


def hold_lock(path, ready, release):
    with single_owner(path):
        ready.set()
        release.wait(20)
