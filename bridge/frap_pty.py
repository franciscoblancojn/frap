#!/usr/bin/env python3
"""Helper PTY sin dependencias para el bridge de FRAP.

Uso: frap_pty.py <cmd> [args...]
  fd 0  -> entrada del usuario (se escribe en el PTY)
  fd 1  <- salida del PTY
  fd 3  -> canal de control, lineas "R <rows> <cols>\n" para redimensionar
Tamano inicial: env FRAP_ROWS / FRAP_COLS.
"""
import os, sys, pty, fcntl, termios, struct, select, signal, errno


def set_size(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main():
    argv = sys.argv[1:] or [os.environ.get("SHELL", "/bin/bash")]
    rows = int(os.environ.get("FRAP_ROWS", "30"))
    cols = int(os.environ.get("FRAP_COLS", "100"))

    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except Exception as e:  # noqa
            sys.stderr.write("frap: no se pudo ejecutar %s: %s\n" % (argv[0], e))
            os._exit(127)

    set_size(master, rows, cols)

    def terminate(signum, _frame):
        try:
            os.killpg(pid, signal.SIGHUP)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGHUP, terminate)

    ctl_open = True
    try:
        os.fstat(3)
    except OSError:
        ctl_open = False
    stdin_open = True
    ctl_buf = b""

    while True:
        fds = [master]
        if stdin_open:
            fds.append(0)
        if ctl_open:
            fds.append(3)
        try:
            r, _, _ = select.select(fds, [], [])
        except InterruptedError:
            continue
        except OSError as e:
            if e.errno == errno.EINTR:
                continue
            break

        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            os.write(1, data)

        if stdin_open and 0 in r:
            data = os.read(0, 65536)
            if not data:
                stdin_open = False
                terminate(None, None)
            else:
                os.write(master, data)

        if ctl_open and 3 in r:
            data = os.read(3, 4096)
            if not data:
                ctl_open = False
            else:
                ctl_buf += data
                while b"\n" in ctl_buf:
                    line, ctl_buf = ctl_buf.split(b"\n", 1)
                    parts = line.decode("ascii", "ignore").split()
                    if len(parts) == 3 and parts[0] == "R":
                        set_size(master, int(parts[1]), int(parts[2]))
                        try:
                            os.killpg(os.getpgid(pid), signal.SIGWINCH)
                        except OSError:
                            pass

    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        code = 0
    sys.exit(code if code >= 0 else 128 - code)


if __name__ == "__main__":
    main()
