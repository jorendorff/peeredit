// An implementation of the Replicated Growable Array (RGA) given in "A
// comprehensive study of Convergent and Commutative Replicated Data Types" by
// Marc Shapiro, Nuno Preguiça, Carlos Baquero, Marek Zawirski, page 34.

var MAX_REPLICA_ID_BITS = 16;

function RGA(id, history) {
  if (typeof id !== "number" || (id | 0) !== id || id < 0 || id >= (1 << MAX_REPLICA_ID_BITS))
    throw new TypeError("RGA constructor: first argument is not a valid id");
  this.id = id;
  this.vr = new Set();
  this.e = new Map([[RGA.left.timestamp, RGA.right]]);
  this._nextTimestamp = id;
  this._subscribers = [];

  if (history !== undefined) {
    for (var i = 0; i < history.length; i++)
      this._downstream(this, history[i]);
  }
}

RGA.left = {atom: undefined, timestamp: -1};
RGA.right = {atom: undefined, timestamp: -2};

RGA.prototype = {
  constructor: RGA,

  _timestamp: function () {
    var t = this._nextTimestamp;
    this._nextTimestamp += (1 << MAX_REPLICA_ID_BITS);
    return t;
  },

  // Apply an operation and broadcast it to other replicas.
  _downstream: function (sender, op) {
    var self = this;
    this["_downstream_" + op.type].call(this, op);
    this._subscribers.forEach(function (obj) {
      if (obj !== sender)
        obj._downstream(self, op);
    });
  },

  // Return an array of ops that builds the entire document.
  history: function () {
    var h = [];
    var prev = RGA.left.timestamp;
    var curr = this.e.get(prev);
    while (curr !== RGA.right) {
      h.push({type: "addRight", t: prev, w: curr});
      if (this.vr.has(curr.timestamp))
        h.push({type: "remove", t: curr.timestamp});
      prev = curr.timestamp;
      curr = this.e.get(prev);
    }
    return h;
  },

  addRight: function (t, a) {
    if (t === RGA.right.timestamp)
      throw new Error("can't add element to the right of the right edge");
    if (!this.e.has(t))
      throw new Error("first argument is not in the array");
    if (this.vr.has(t))
      throw new Error("first argument is removed from the array");

    var node = {atom: a, timestamp: this._timestamp()};
    this._downstream(this, {type: "addRight", t: t, w: node});
    return node.timestamp;
  },

  _downstream_addRight: function (op) {
    // Any future timestamps we generate must be after timestamps we've
    // observed.
    if (op.w.timestamp >= this._nextTimestamp) {
      var t = (op.w.timestamp >>> MAX_REPLICA_ID_BITS) + 1;
      this._nextTimestamp = (t << MAX_REPLICA_ID_BITS) + this.id;
    }

    var t = op.t, w = op.w;
    var l = t;
    var r = this.e.get(l);
    if (r === undefined)
      throw new Error("downstream: can't add next to unknown element!");
    for (;;) {
      if (w.timestamp < r.timestamp) {
        l = r.timestamp;
        r = this.e.get(l);
      } else {
        // Remove old edge, add new ones.
        this.e.set(l, w);
        this.e.set(w.timestamp, r);
        break;
      }
    }
  },

  _lookup: function (t) {
    return this.e.has(t) && !this.vr.has(t);
  },

  remove: function (t) {
    if (!this._lookup(t))
      throw new Error("can't remove node that doesn't exist");
    this._downstream(this, {type: "remove", t: t});
  },

  _downstream_remove: function (op) {
    var t = op.t;
    if (!this.e.has(t))
      throw new Error("downstream: can't remove unknown element!");
    this.vr.add(t);
  },

  text: function () {
    var s = "";
    for (var v = this.e.get(RGA.left.timestamp); v !== RGA.right; v = this.e.get(v.timestamp)) {
      if (!this.vr.has(v.timestamp))
        s += v.atom;
    }
    return s;
  },

  // Get the node immediately to the left of the given cursor location.
  // If line == 0 and column == 0, this returns RGA.left.
  getNodeAt: function (line, column) {
    var l = 0, c = 0;
    var v = RGA.left;
    while (v !== RGA.right && (l < line || (l === line && c < column))) {
      v = this.e.get(v.timestamp);
      if (!this.vr.has(v.timestamp)) {
        if (v.atom ==="\n") {
          l++;
          c = 0;
        } else {
          c++;
        }
      }
    }
    return v;
  },

  getRowColumnBefore: function (t) {
    if (t === RGA.left.timestamp)
      throw new Error("no position before the left edge of the document");
    if (!this.e.has(t))
      throw new Error("timestamp not present in document");
    var r = 0, c = 0;
    for (var v = this.e.get(RGA.left.timestamp); v.timestamp !== t; v = this.e.get(v.timestamp)) {
      if (!this.vr.has(v.timestamp)) {
        if (v.atom === "\n") {
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
    if (!this.e.has(t))
      throw new Error("toRowColumn: timestamp not found in document");
    var r = 0, c = -1;  // c will be incremented to zero in the first pass through the loop
    for (var v = RGA.left; v !== RGA.right; v = this.e.get(v.timestamp)) {
      if (!this.vr.has(v.timestamp)) {
        if (v.atom === "\n") {
          r++;
          c = 0;
        } else {
          c++;
        }
        if (v.timestamp === t)
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
    var v = this.getNodeAt(line, column);
    for (var i = 0; i < length; i++) {
      var next = this.e.get(v.timestamp);
      while (this.vr.has(next.timestamp)) {
        v = next;
        next = this.e.get(v.timestamp);
        if (next === RGA.right)
          return;
      }
      this._downstream(source, {type: "remove", t: next.timestamp});
    }
  }
};

RGA.tie = function tie(a, b) {
  a._subscribers.push(b);
  b._subscribers.push(a);
};

RGA.tieToSocket = function tieToSocket(a, s) {
  var proxy = {
    _downstream: function (sender, op) {
      s.emit("downstream", op);
    }
  };
  a._subscribers.push(proxy);
  s.on("downstream", function (op) {
    a._downstream(proxy, op);
  });

  // Cleanup.
  s.on("disconnect", function () {
    var i = a._subscribers.indexOf(proxy);
    a._subscribers.splice(i, 1);
  });
};

RGA.tieToAceEditor = function tieToAceEditor(rga, editor) {
  var panic = false;
  var ignoreEvents = [];

  // The flow of operations is bidirectional. First, implement delivery
  // of ops from the RGA to the editor.
  var rgaToEditorPipe = {
    _downstream: function (source, op) {
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
    }
  };
  rga._subscribers.push(rgaToEditorPipe);

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
      rga.insertRowColumn(rgaToEditorPipe, e.start.row, e.start.column, e.lines.join("\n"));
    } else if (e.action === "remove") {
      rga.removeRowColumn(rgaToEditorPipe, e.start.row, e.start.column, e.lines.join("\n").length);
    }
  });
};

if (typeof module !== "undefined")
  exports = module.exports = RGA;
