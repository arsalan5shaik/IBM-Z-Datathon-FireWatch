import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path


def durable_replace(source, target):
    os.replace(source, target)
    if os.name != "nt":
        directory_fd = os.open(Path(target).parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


def atomic_json(path: Path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()
    fd, name = tempfile.mkstemp(prefix=".publish-", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        durable_replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class JobLocked(Exception):
    pass


@contextmanager
def single_owner(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise JobLocked("Another scheduler owns publication") from None
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
