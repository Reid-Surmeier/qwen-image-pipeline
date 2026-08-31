import ctypes
import errno
import os
import socket


libc = ctypes.CDLL(None, use_errno=True)
socket_fd = libc.syscall(41, socket.AF_INET, socket.SOCK_DGRAM, 0)
if socket_fd < 0:
    raise OSError(ctypes.get_errno(), "raw socket creation failed")
try:
    address = bytes((2, 0, 0, 9, 127, 0, 0, 1)) + bytes(8)
    payload = ctypes.create_string_buffer(b"x")
    result = libc.syscall(
        44,
        socket_fd,
        payload,
        1,
        0,
        address,
        len(address),
    )
    if result != -1 or ctypes.get_errno() != errno.EPERM:
        raise SystemExit("raw network syscall escaped the deterministic baseline")
    print("raw network syscall is disabled in the deterministic baseline")
finally:
    os.close(socket_fd)
