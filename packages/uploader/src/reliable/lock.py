"""Hold a kernel flock until the Node parent closes stdin or dies."""

import fcntl
import os
import sys


def main():
    fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("held", flush=True)
            return
        print("acquired", flush=True)
        sys.stdin.buffer.read()
    finally:
        os.close(fd)


if __name__ == "__main__":
    main()
