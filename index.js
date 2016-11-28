// Peeredit: conflict-free collaborative editing

"use strict";

// This is a typical Node server. Plug together a few blocks and you've got an
// HTTP server.
var app = require('express')();
var server = require('http').Server(app);

// Add slow.io for communication between browser and server
// with adjustable artifical latency.
var io = require('slow.io')(server);

// The server knows how to serve two files: index.html and lib/rga.js.  (It's
// not *quite* that simple really. Attaching slow.io to the server, above, adds
// more functionality to the server. It can now serve a couple of scripts:
// '/socket.io/socket.io.js' and '/slow.io/slow.io.js'.)
app.get('/', function (req, res) {
  res.sendFile(__dirname + "/index.html");
});

app.get('/lib/rga.js', function (req, res) {
  res.sendFile(__dirname + "/lib/rga.js");
});

// The document model is a "Replicated Global Array", implemented in a separate
// module. Each client has a replica of the document, represented by an RGA
// that lives in the browser. There's also a central replica `doc` on the
// server.
var RGA = require('./lib/rga.js');
var doc = new RGA(0);
var nextUserId = 1;  // Used to generate a unique id for each user.

// Now all we have to do is handle socket.io connections so people can interact
// with the document. For example, every time a user connects:
io.on('connection', function (socket) {
  // Populate the new client with a user id and the full document.
  var userId = nextUserId++;
  console.log("connection - assigning id " + userId);
  socket.emit("welcome", {id: userId, history: doc.history()});

  // Propagate ops between the new client and `doc`. Since `doc` is also tied
  // to all other clients, they form one network, and edits at one client will
  // eventually reach all replicas.
  RGA.tieToSocket(doc, socket);
});

// Actually start the server. Enjoy!
var port = Number(process.env.PORT) || 3001;
server.listen(port, function () {
  console.log('listening on *:' + port);
});
