import socket


with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
    connection.sendto(b"x", ("127.0.0.1", 9))
