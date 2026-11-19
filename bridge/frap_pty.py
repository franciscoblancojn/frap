#!/usr/bin/env python3
"""Sesión PTY persistente de FRAP (solo stdlib).

Uso: frap_pty.py --sock RUTA [--rows N --cols N] -- <cmd> [args...]

Se ejecuta DESLIGADO del bridge: si el bridge se reinicia o se cae, la sesión sigue viva.
El bridge se conecta (y reconecta) por un socket Unix. Protocolo de tramas:
    tipo (1 byte) + longitud (4 bytes big-endian) + datos
  helper -> bridge:  B = historial al conectar · O = salida · X = terminó (código ASCII)
  bridge -> helper:  I = entrada · R = "filas columnas" · K = terminar la sesión
Solo hay un cliente a la vez: una conexión nueva reemplaza a la anterior.
Al terminar escribe el código en <sock>.exit y borra el socket.
"""
import argparse, errno, fcntl, os, pty, select, signal, socket, struct, sys, termios

BACKLOG_MAX = 512 * 1024


def set_size(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def frame(kind, data=b""):
    return kind + struct.pack(">I", len(data)) + data


def utf8_start(buf):
    """Recorta bytes de continuación UTF-8 al inicio (el historial se cortó a mitad de carácter)."""
    i = 0
    while i < len(buf) and i < 4 and (buf[i] & 0xC0) == 0x80:
        i += 1
    return bytes(buf[i:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sock", required=True)
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--cols", type=int, default=100)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    cmd = cmd or [os.environ.get("SHELL", "/bin/bash")]

    # socket primero: si falla, no se lanza nada
    try:
        os.unlink(a.sock)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    srv.bind(a.sock)
    os.umask(old)
    srv.listen(2)

    pid, master = pty.fork()
    if pid == 0:
        srv.close()
        try:
            os.execvp(cmd[0], cmd)
        except Exception as e:  # noqa
            sys.stderr.write("frap: no se pudo ejecutar %s: %s\n" % (cmd[0], e))
            os._exit(127)

    set_size(master, a.rows, a.cols)

    def terminate(*_):
        for target in (lambda: os.killpg(pid, signal.SIGHUP), lambda: os.kill(pid, signal.SIGHUP)):
            try:
                target()
            except OSError:
                pass

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)  # el bridge que muere no debe matarnos
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    backlog = bytearray()
    client = None
    inbuf = b""

    def drop_client():
        nonlocal client, inbuf
        if client is not None:
            try:
                client.close()
            except OSError:
                pass
        client = None
        inbuf = b""

    def send(data):
        if client is None:
            return
        try:
            client.sendall(data)
        except OSError:
            drop_client()

    while True:
        fds = [master, srv] + ([client] if client is not None else [])
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
            backlog += data
            if len(backlog) > BACKLOG_MAX:
                del backlog[: len(backlog) - BACKLOG_MAX]
            send(frame(b"O", data))

        if srv in r:
            try:
                conn, _ = srv.accept()
            except OSError:
                conn = None
            if conn is not None:
                drop_client()
                client = conn
                client.setblocking(True)
                send(frame(b"B", utf8_start(backlog)))

        if client is not None and client in r:
            try:
                data = client.recv(65536)
            except OSError:
                data = b""
            if not data:
                drop_client()
                continue
            inbuf += data
            while len(inbuf) >= 5:
                kind = inbuf[:1]
                (n,) = struct.unpack(">I", inbuf[1:5])
                if len(inbuf) < 5 + n:
                    break
                payload, inbuf = inbuf[5 : 5 + n], inbuf[5 + n :]
                if kind == b"I":
                    try:
                        os.write(master, payload)
                    except OSError:
                        pass
                elif kind == b"R":
                    parts = payload.decode("ascii", "ignore").split()
                    if len(parts) == 2:
                        set_size(master, int(parts[0]), int(parts[1]))
                        try:
                            os.killpg(os.getpgid(pid), signal.SIGWINCH)
                        except OSError:
                            pass
                elif kind == b"K":
                    terminate()

    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        code = 0
    if code < 0:
        code = 128 - code
    try:
        with open(a.sock + ".exit", "w") as f:
            f.write(str(code))
    except OSError:
        pass
    # comando que terminó antes de que el bridge se conectara (p. ej. `sh -c 'echo hola'`):
    # se espera un poco a un cliente para entregarle la salida y el código
    if client is None:
        srv.settimeout(10)
        try:
            conn, _ = srv.accept()
            conn.settimeout(None)
            client = conn
            send(frame(b"B", utf8_start(backlog)))
        except OSError:
            pass
    send(frame(b"X", str(code).encode()))
    drop_client()
    try:
        os.unlink(a.sock)
    except OSError:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
