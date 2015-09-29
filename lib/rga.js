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

RGA.tie = function tie(a, b) {
  a._subscribers.push(b);
  b._subscribers.push(a);
};

RGA.tieToSocket = function tieToSocket(a, s) {
  var proxy = {
    _downstream(sender, op) {
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
    var prev = RGA.left;
    var curr = this.successor(prev);
    while (curr !== RGA.right) {
      h.push({type: "addRight", u: prev, w: curr});
      if (this.vr.has(curr.timestamp))
        h.push({type: "remove", w: curr});
      prev = curr;
      curr = this.successor(prev);
    }
    return h;
  },

  successor: function (u) {
    return this.e.get(u.timestamp);
  },

  addRight: function (u, a) {
    if (u === RGA.right)
      throw new Error("can't add element to the right of the right edge");
    if (!this.e.has(u.timestamp))
      throw new Error("first argument is not in the array");
    if (this.vr.has(u.timestamp))
      throw new Error("first argument is removed from the array");

    var node = {atom: a, timestamp: this._timestamp()};
    this._downstream(this, {type: "addRight", u: u, w: node});
    return node;
  },

  _downstream_addRight: function (op) {
    // Any future timestamps we generate must be after timestamps we've
    // observed.
    if (op.w.timestamp >= this._nextTimestamp) {
      var t = (op.w.timestamp >>> MAX_REPLICA_ID_BITS) + 1;
      this._nextTimestamp = (t << MAX_REPLICA_ID_BITS) + this.id;
    }

    var u = op.u, w = op.w;
    var l = u;
    var r = this.successor(l);
    if (r === undefined)
      throw new Error("downstream: can't add next to unknown element!");
    for (;;) {
      if (w.timestamp < r.timestamp) {
        l = r;
        r = this.successor(l);
      } else {
        // Remove old edge, add new ones.
        this.e.set(l.timestamp, w);
        this.e.set(w.timestamp, r);
        break;
      }
    }
  },

  _lookup: function (v) {
    return this.e.has(v.timestamp) && !this.vr.has(v.timestamp);
  },

  remove: function (w) {
    if (!this._lookup(w))
      throw new Error("can't remove node that doesn't exist");
    this._downstream(this, {type: "remove", w: w});
  },

  _downstream_remove: function (op) {
    var w = op.w;
    if (!this.e.has(w.timestamp))
      throw new Error("downstream: can't remove unknown element!");
    this.vr.add(w.timestamp);
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

  toRowColumn: function (node) {
    if (!this._lookup(node))
      throw new Error("toRowColumn: node not in document");
    var r = 0, c = 0;
    for (var v = this.e.get(RGA.left.timestamp); v !== RGA.right; v = this.e.get(v.timestamp)) {
      if (!this.vr.has(v.timestamp)) {
        if (v.atom === "\n") {
          r++;
          c = 0;
        } else {
          c++;
        }
        if (v.timestamp === node.timestamp)
          break;
      }
    }
    return {row: r, column: c};
  },

  insertRowColumn: function (source, line, column, text) {
    var r = 1;
    var u = this.getNodeAt(line, column);
    for (var i = 0; i < text.length; i++) {
      var node = {atom: text[i], timestamp: this._timestamp()};
      this._downstream(source, {type: "addRight", u: u, w: node});
      u = node;
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
      this._downstream(source, {type: "remove", w: next});
    }
  }
};

if (typeof module !== "undefined")
  exports = module.exports = RGA;
