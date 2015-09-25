// An implementation of the Replicated Growable Array (RGA) given in "A
// comprehensive study of Convergent and Commutative Replicated Data Types" by
// Marc Shapiro, Nuno Preguiça, Carlos Baquero, Marek Zawirski, page 34.

function equalNodes(a, b) {
  return a.atom === b.atom && a.timestamp === b.timestamp;
}


function NodeSet(seq) {
  this._data = [];
  if (seq !== undefined) {
    for (var n of seq)
      this.add(n);
  }
}

NodeSet.prototype = {
  constructor: NodeSet,

  _look(t) {
    var s = this._data[t];
    if (s === undefined)
      s = this._data[t] = new Set();
    return s;
  },

  has(v) {
    var s = this._data[v.timestamp];
    return s !== undefined && s.has(v.atom);
  },

  add(v) {
    this._look(v.timestamp).add(v.atom);
  }
};


function NodeMap(pairs) {
  this._data = [];
  if (pairs !== undefined) {
    for (var n of pairs)
      this.set(n[0], n[1]);
  }
}

NodeMap.prototype = {
  constructor: NodeMap,

  _look(t) {
    var m = this._data[t];
    if (m === undefined)
      m = this._data[t] = new Map();
    return m;
  },

  has(k) {
    var m = this._data[k.timestamp];
    return m !== undefined && m.has(k.atom);
  },

  get(k) {
    var m = this._data[k.timestamp];
    return m === undefined ? undefined : m.get(k.atom);
  },

  set(k, v) {
    this._look(k.timestamp).set(k.atom, v);
  },

  *[Symbol.iterator]() {
    for (var t in this._data) {
      t = Number(t);
      var m = this._data[t];
      for (var p of m) {
        yield [{atom: p[0], timestamp: t}, p[1]];
      }
    }
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
    for (var item of history)
      this._downstream.apply(this, [undefined].concat(item));
  }
}

RGA.left = {atom: undefined, timestamp: -1};
RGA.right = {atom: undefined, timestamp: 0};

RGA.prototype = {
  constructor: RGA,

  _timestamp() {
    var t = this._nextTimestamp;
    this._nextTimestamp += (1 << MAX_REPLICA_ID_BITS);
    return t;
  },
  
  // Apply an operation and broadcast it to other replicas.
  _downstream(sender, op) {
    this["_downstream_" + op.type].call(this, op);
    for (var obj of this._subscribers) {
      if (obj !== sender)
        obj._downstream(this, op);
    }
  },

  // Yield a sequence of ops that builds the entire document.
  *history() {
    var prev = RGA.left;
    var curr = this.successor(prev);
    while (curr !== RGA.right) {
      yield {type: "addRight", u: prev, w: curr};
      if (this.vr.has(curr))
        yield {type: "remove", w: curr};
      prev = curr;
      curr = this.successor(prev);
    }
  },
  
  successor(u) {
    return this.e.get(u);
  },

  addRight(u, a) {
    if (u.timestamp === 0)
      throw new Error("can't add element to the right of the right edge");
    if (!this.e.has(u))
      throw new Error("first argument is not in the array");
    if (this.vr.has(u))
      throw new Error("first argument is removed from the array");

    var node = {atom: a, timestamp: this._timestamp()};
    this._downstream(this, {type: "addRight", u: u, w: node});
    return node;
  },

  _downstream_addRight(op) {
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

  _lookup(v) {
    return this.e.has(v) && !this.vr.has(v);
  },

  remove(w) {
    if (!this._lookup(w))
      throw new Error("can't remove node that doesn't exist");
    this._downstream(this, {type: "remove", w: w});
  },

  _downstream_remove(op) {
    var w = op.w;
    if (!this.e.has(w))
      throw new Error("downstream: can't remove unknown element!");
    this.vr.add(w);
  },

  text() {
    var s = "";
    for (var v = this.e.get(RGA.left); !equalNodes(v, RGA.right); v = this.e.get(v)) {
      if (!this.vr.has(v))
        s += v.atom;
    }
    return s;
  }
};

exports = module.exports = RGA;
