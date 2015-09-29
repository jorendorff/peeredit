// An implementation of the Replicated Growable Array (RGA) given in "A
// comprehensive study of Convergent and Commutative Replicated Data Types" by
// Marc Shapiro, Nuno Preguiça, Carlos Baquero, Marek Zawirski, page 34.

function NodeSet(arr) {
  this._data = {};
  if (arr !== undefined) {
    for (var i = 0; i < arr.length; i++)
      this.add(arr[i]);
  }
}

NodeSet.prototype = {
  constructor: NodeSet,

  _look: function (t) {
    var s = this._data[t];
    if (s === undefined)
      s = this._data[t] = new Set();
    return s;
  },

  has: function (v) {
    var s = this._data[v.timestamp];
    return s !== undefined && s.has(v.atom);
  },

  add: function (v) {
    this._look(v.timestamp).add(v.atom);
  }
};


function NodeMap(pairs) {
  this._data = {};
  if (pairs !== undefined) {
    for (var i = 0; i < pairs.length; i++) {
      var n = pairs[i];
      this.set(n[0], n[1]);
    }
  }
}

NodeMap.prototype = {
  constructor: NodeMap,

  _look: function (t) {
    var m = this._data[t];
    if (m === undefined)
      m = this._data[t] = new Map();
    return m;
  },

  has: function (k) {
    var m = this._data[k.timestamp];
    return m !== undefined && m.has(k.atom);
  },

  get: function (k) {
    var m = this._data[k.timestamp];
    return m === undefined ? undefined : m.get(k.atom);
  },

  set: function (k, v) {
    this._look(k.timestamp).set(k.atom, v);
  },

  entries: function () {
    var e = [];
    for (var t in this._data) {
      t = Number(t);
      var m = this._data[t];
      for (var p of m) {
        e.push([{atom: p[0], timestamp: t}, p[1]]);
      }
    }
    return e;
  }
};

var MAX_REPLICA_ID_BITS = 16;

function RGA(id, history) {
  this.id = id;
  this.vr = new NodeSet();
  this.e = new NodeMap([[RGA.left, RGA.right]]);
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
      if (this.vr.has(curr))
        h.push({type: "remove", w: curr});
      prev = curr;
      curr = this.successor(prev);
    }
    return h;
  },

  successor: function (u) {
    return this.e.get(u);
  },

  addRight: function (u, a) {
    if (u === RGA.right)
      throw new Error("can't add element to the right of the right edge");
    if (!this.e.has(u))
      throw new Error("first argument is not in the array");
    if (this.vr.has(u))
      throw new Error("first argument is removed from the array");

    var node = {atom: a, timestamp: this._timestamp()};
    this._downstream(this, {type: "addRight", u: u, w: node});
    return node;
  },

  _downstream_addRight: function (op) {
    // Any future timestamps we generate must be after timestamps we've
    // observed.
    if (op.w.timestamp > this._nextTimestamp) {
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
        this.e.set(l, w);
        this.e.set(w, r);
        break;
      }
    }
  },

  _lookup: function (v) {
    return this.e.has(v) && !this.vr.has(v);
  },

  remove: function (w) {
    if (!this._lookup(w))
      throw new Error("can't remove node that doesn't exist");
    this._downstream(this, {type: "remove", w: w});
  },

  _downstream_remove: function (op) {
    var w = op.w;
    if (!this.e.has(w))
      throw new Error("downstream: can't remove unknown element!");
    this.vr.add(w);
  },

  text: function () {
    var s = "";
    for (var v = this.e.get(RGA.left); v !== RGA.right; v = this.e.get(v)) {
      if (!this.vr.has(v))
        s += v.atom;
    }
    return s;
  },

  // Get the node immediately to the left of the given cursor location.
  // If line == 0 and column == 0, this returns RGA.left.
  getNodeAt(line, column) {
    var l = 0, c = 0;
    var v = RGA.left;
    while (v !== RGA.right && (l < line || (l === line && c < column))) {
      v = this.e.get(v);
      if (!this.vr.has(v)) {
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

  insertRowColumn(line, column, text) {
    var r = 1;
    var v = this.getNodeAt(line, column);
    for (var ch of text)
      v = this.addRight(v, ch);
  },

  removeRowColumn(line, column, length) {
    var v = this.getNodeAt(line, column);
    for (var i = 0; i < length; i++) {
      var next = this.e.get(v);
      while (this.vr.has(next)) {
        v = next;
        next = this.e.get(v);
        if (next === RGA.right)
          return;
      }
      this.remove(next);
    }
  }
};

if (typeof module !== "undefined")
  exports = module.exports = RGA;
