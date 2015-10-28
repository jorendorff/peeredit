// An implementation of the Replicated Growable Array (RGA) given in "A
// comprehensive study of Convergent and Commutative Replicated Data Types" by
// Marc Shapiro, Nuno Preguiça, Carlos Baquero, Marek Zawirski, page 34.

"use strict";

var MAX_REPLICA_ID_BITS = 16;

function RGA(id, history) {
  if (typeof id !== "number" || (id | 0) !== id || id < 0 || id >= (1 << MAX_REPLICA_ID_BITS))
    throw new TypeError("RGA constructor: first argument is not a valid id");
  this.id = id;
  this.left = {next: undefined, timestamp: -1, atom: undefined, removed: false};
  this._index = new Map([[this.left.timestamp, this.left]]);
  this._nextTimestamp = id;
  this._subscribers = [];

  var self = this;
  this.downstream = function (sender, op) {
    self._downstream(sender, op);
  };

  if (history !== undefined) {
    for (var i = 0; i < history.length; i++)
      this._downstream(this.downstream, history[i]);
  }
}

RGA.prototype = {
  constructor: RGA,

  _timestamp: function () {
    var t = this._nextTimestamp;
    this._nextTimestamp += (1 << MAX_REPLICA_ID_BITS);
    return t;
  },

  // Apply an operation and broadcast it to other replicas.
  _downstream: function (sender, op) {
    var self = this.downstream;
    this["_downstream_" + op.type].call(this, op);
    this._subscribers.forEach(function (callback) {
      if (callback !== sender)
        callback(self, op);
    });
  },

  // Add an event listener. An RGA only emits one kind of event: "op".
  on: function (type, callback) {
    if (type === "op")
      this._subscribers.push(callback);
  },

  // Remove an event listener.
  off: function (type, callback) {
    if (type === "op") {
      var i = this._subscribers.indexOf(callback);
      if (i !== -1)
        this._subscribers.splice(i, 1);
    }
  },

  // Return an array of ops that builds the entire document.
  history: function () {
    var h = [];
    var prev = this.left;
    var curr = prev.next;
    while (curr !== undefined) {
      h.push({
        type: "addRight",
        t: prev.timestamp,
        w: {timestamp: curr.timestamp, atom: curr.atom}
      });
      if (curr.removed)
        h.push({type: "remove", t: curr.timestamp});
      prev = curr;
      curr = curr.next;
    }
    return h;
  },

  addRight: function (t, a) {
    var pred = this._index.get(t);
    if (pred === undefined)
      throw new Error("insertion point is not in the array");
    if (pred.removed)
      throw new Error("insertion point is removed from the array");

    var node = {timestamp: this._timestamp(), atom: a};
    this._downstream(this.downstream, {type: "addRight", t: t, w: node});
    return node.timestamp;
  },

  _downstream_addRight: function (op) {
    // Any future timestamps we generate must be after timestamps we've
    // observed.
    if (op.w.timestamp >= this._nextTimestamp) {
      var t = (op.w.timestamp >>> MAX_REPLICA_ID_BITS) + 1;
      this._nextTimestamp = (t << MAX_REPLICA_ID_BITS) + this.id;
    }

    var w = op.w;
    var pred = this._index.get(op.t);
    if (pred === undefined)
      throw new Error("downstream: can't add next to unknown element!");
    while (pred.next && w.timestamp < pred.next.timestamp)
      pred = pred.next;

    // Splice a new node into the linked list.
    var node = {
      next: pred.next,
      timestamp: w.timestamp,
      atom: w.atom,
      removed: false
    };
    pred.next = node;
    this._index.set(w.timestamp, node);
  },

  _lookup: function (t) {
    var node = this._index.get(t);
    return node !== undefined && !node.removed;
  },

  remove: function (t) {
    if (!this._lookup(t))
      throw new Error("can't remove node that doesn't exist");
    this._downstream(this.downstream, {type: "remove", t: t});
  },

  _downstream_remove: function (op) {
    var node = this._index.get(op.t);
    if (node === undefined)
      throw new Error("downstream: can't remove unknown element!");
    if (node.removed)
      throw new Error("downstream: element already removed");
    node.removed = true;
  },

  text: function () {
    var s = "";
    for (var node = this.left.next; node; node = node.next) {
      if (!node.removed)
        s += node.atom;
    }
    return s;
  },

  // Get the node immediately to the left of the given cursor location.
  // If line == 0 and column == 0, this returns this.left.
  getNodeAt: function (line, column) {
    var l = 0, c = 0;
    var node = this.left;
    while (node && (l < line || (l === line && c < column))) {
      node = node.next;
      if (!node.removed) {
        if (node.atom ==="\n") {
          l++;
          c = 0;
        } else {
          c++;
        }
      }
    }
    return node;
  },

  getRowColumnBefore: function (t) {
    if (t === this.left.timestamp)
      throw new Error("no position before the left edge of the document");
    if (!this._index.has(t))
      throw new Error("timestamp not present in document");
    var r = 0, c = 0;
    for (var node = this.left; node; node = node.next) {
      if (!node.removed) {
        if (node.atom === "\n") {
          r++;
          c = 0;
        } else {
          c++;
        }
      }
    }
    return {row: r, column: c};
  },

  getRowColumnAfter: function (t) {
    if (!this._index.has(t))
      throw new Error("timestamp not present in document");
    var r = 0, c = -1;  // c will be incremented to zero in the first pass through the loop
    for (var node = this.left; node; node = node.next) {
      if (!node.removed) {
        if (node.atom === "\n") {
          r++;
          c = 0;
        } else {
          c++;
        }
        if (node.timestamp === t)
          break;
      }
    }
    return {row: r, column: c};
  },

  insertRowColumn: function (source, line, column, text) {
    var r = 1;
    var u = this.getNodeAt(line, column).timestamp;
    for (var i = 0; i < text.length; i++) {
      var node = {atom: text[i], timestamp: this._timestamp()};
      this._downstream(source, {type: "addRight", t: u, w: node});
      u = node.timestamp;
    }
  },

  removeRowColumn: function (source, line, column, length) {
    var node = this.getNodeAt(line, column);
    for (var i = 0; i < length; i++) {
      node = node.next;
      while (node && node.removed)
        node = node.next;
      if (!node)
        throw new Error("tried to remove more characters than exist in document");
      this._downstream(source, {type: "remove", t: node.timestamp});
    }
  },

  applyQuillDelta: function (source, delta) {
    var lastNode = this.left, node = lastNode.next;
    var ops = delta.ops;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      console.log("* applying", op);
      if ("retain" in op) {
        for (var j = 0; j < op.retain;) {
          if (!node.removed) {
            lastNode = node;
            j++;
          }
          node = node.next;
        }
      } else if ("delete" in op) {
        for (var j = 0; j < op.delete;) {
          var next = node.next;
          if (!node.removed) {
            lastNode = node;
            j++;
            console.log("removing character:", node.atom);
            this._downstream(source, {type: "remove", t: node.timestamp});
          }
          node = next;
        }
      } else if ("insert" in op) {
        var t = lastNode.timestamp;
        var str = op.insert;
        for (var j = 0; j < str.length; j++) {
          console.log("inserting character:", str[j]);
          var tnext = this._timestamp();
          var next = {atom: str[j], timestamp: tnext};
          this._downstream(source, {type: "addRight", t: t, w: next});
          t = tnext;
        }
        lastNode = this._index.get(t);
        node = lastNode.next;
      }
    }
  }
};

// Cause two RGA objects to update each other.
// They must initially contain the same history.
RGA.tie = function tie(a, b) {
  if (JSON.stringify(a.history()) != JSON.stringify(b.history()))
    throw new Error("RGA.tie: arguments must start out already in sync");

  a.on("op", b.downstream);
  b.on("op", a.downstream);
};

// Cause an RGA object to communicate via socket.io to update an RGA object
// tied to the other end of the socket. The two RGA objects must initially
// contain the same history.
RGA.tieToSocket = function tieToSocket(a, s) {
  var a_s = function (sender, op) {
    s.emit("downstream", op);
  };
  a.on("op", a_s);
  s.on("downstream", function (op) {
    a.downstream(a_s, op);
  });

  // Cleanup.
  s.on("disconnect", function () {
    a.off("op", a_s);
  });
};

RGA.tieToQuillEditor = function tieToQuillEditor(rga, quill) {
  if (rga.text().trimRight() !== quill.getText().trimRight())
    throw new Error("RGA.tieToQuillEditor: arguments must start out already in sync");

  // When someone makes a change to the RGA, apply it to the editor.
  var rgaToEditor = function (source, op) {
    console.log("received from rga, from socket:", op);
    switch (op.type) {
    case "addRight":
      quill.insertText(rga.timestampToIndex(op.t), op.w.atom);
      break;
    case "remove":
      {
        var i = rga.timestampToIndex(op.t);
        quill.deleteText(i, i + 1);
      }
      break;
    }
  };
  rga.on("op", rgaToEditor);

  // When the user makes a change in the editor, apply it to the RGA.
  quill.on("text-change", function(delta, who) {
    if (who == "user") {
      console.log("applying patch", delta);
      rga.applyQuillDelta(rgaToEditor, delta);
      console.log("did it work?", rga.text().trimLeft());// == quill.getText().trimLeft());
    }
  });
};

// Cause an RGA object and an instance of the Ace editor update each other.
// The two must initially contain the same text.
RGA.tieToAceEditor = function tieToAceEditor(rga, editor) {
  if (rga.text() != editor.getValue())
    throw new Error("RGA.tieToAceEditor: arguments must start out already in sync");

  var panic = false;
  var ignoreEvents = [];

  // The flow of operations is bidirectional. First, implement delivery
  // of ops from the RGA to the editor.
  var rgaToEditor = function (source, op) {
    if (panic)
      return;
    console.log("received from rga, from socket:", op);

    switch (op.type) {
    case "addRight":
      var loc = rga.getRowColumnAfter(op.t);
      ignoreEvents.push({
        action: "insert",
        start: loc,
        lines: op.w.atom.split("\n")
      });
      editor.getSession().insert(loc, op.w.atom);
      break;

    case "remove":
      console.log("remove:", op.t, " from:", rga);
      var loc = rga.getRowColumnBefore(op.t);
      ignoreEvents.push({
        action: "remove",
        start: loc
      });
      var removingNewline = editor.getSession().doc.getLine(loc.row).length === loc.column;
      editor.getSession().remove({
        start: loc,
        end: removingNewline
          ? {row: loc.row + 1, column: 0}
        : {row: loc.row, column: loc.column + 1}
      });
      break;
    }
  };
  rga.on("op", rgaToEditor);

  // And second, implement the flow of ops from the editor to the RGA,
  // being careful not to forward events generated by ops that came
  // from the RGA in the first place (!).
  editor.getSession().on("change", function (e) {
    if (panic)
      return;
    console.log("change", e);
    if (ignoreEvents.length > 0) {
      if (ignoreEvents[0].action === e.action &&
          ignoreEvents[0].start.row === e.start.row &&
          ignoreEvents[0].start.column === e.start.column &&
          (!("lines" in ignoreEvents[0]) ||
           ignoreEvents[0].lines.join("\n") === e.lines.join("\n"))) {
        console.log("ignoring event, because it came from the editor");
        ignoreEvents.shift();
        return;
      } else {
        console.log("Uh oh, something weird happened. Expected event:", ignoreEvents[0]);
        if (ignoreEvents.length > 1)
          console.log("and", ignoreEvents.length - 1, "other events:", ignoreEvents.slice(1));
        console.log("Received event:", e);
        panic = true;
        alert("updates disabled");
        return;
      }
    }
    if (e.action === "insert") {
      rga.insertRowColumn(rgaToEditor, e.start.row, e.start.column, e.lines.join("\n"));
    } else if (e.action === "remove") {
      rga.removeRowColumn(rgaToEditor, e.start.row, e.start.column, e.lines.join("\n").length);
    }
  });
};

if (typeof module !== "undefined")
  exports = module.exports = RGA;
