var socketpair = require("../lib/socketpair.js");
var assert = require("assert");

describe("socketpair", () => {
  it("delivers messages only on demand", () => {
    var pair = socketpair();
    var a = pair[0];
    var b = pair[1];

    var log = "";
    a.on("syn", x => {
      log += "A" + x;
      a.emit("ack", x);
    });
    b.on("syn", x => {
      log += " B" + x;
      b.emit("ack", x);
    });

    a.on("ack", x => { log += " a" + x; });
    b.on("ack", x => { log += " b" + x; });

    a.emit("syn", 1);
    b.emit("syn", 2);
    assert(log === "");

    // Easy to test, since delivery is now deterministic.
    b.deliver("syn", 2);  // deliver this message to b, so that `b.on` handlers run.
    assert(log === "A2");
    a.deliver("syn", 1);
    assert(log === "A2 B1");
    a.deliver("ack", 2);
    assert(log === "A2 B1 b2");
    b.deliver("ack", 1);
    assert(log === "A2 B1 b2 a1");
  });
});
