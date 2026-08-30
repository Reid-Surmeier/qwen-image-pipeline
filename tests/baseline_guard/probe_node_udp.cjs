"use strict";

const connection = require("node:dgram").createSocket("udp4");
connection.send(Buffer.from("x"), 9, "127.0.0.1");
