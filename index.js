// Peeredit: conflict-free collaborative editing

// This is a typical Node server. Plug together a few blocks and you've got an
// HTTP server.
var app = require('express')();
var server = require('http').Server(app);

// Add socket.io for fast communication between browser and server.
// (We really should add "slowio", like Univax)
var io = require('socket.io')(server);

// The server only knows how to send a single page, index.html.  (It's not
// *quite* that simple really. Attaching socket.io to the server, above, adds
// more functionality to the server. It can now serve 'socket.io/socket.io.js',
// the browser-side half of socket.io.)
app.get('/', function (req, res) {
  res.sendFile(__dirname + "/index.html");
});

app.get('/lib/rga.js', function (req, res) {
  res.sendFile(__dirname + "/lib/rga.js");
});

// The document model is a "Replicated Global Array", implemented in a separate
// module.
var RGA = require('./lib/rga.js');
var doc = new RGA(0);
var nextUserId = 0;  // Used to generate a unique id for each user.

// Now all we have to do is handle socket.io connections so people can interact
// with the document. For example, every time a user connects:
io.on('connection', function (socket) {
  // Populate the new client with a user id and the full document.
  var userId = nextUserId++;
  socket.emit("welcome", {id: userId, history: doc.history()});
  RGA.tieToSocket(doc, socket);
});

// Actually start the server. Enjoy!
var port = Number(process.env.PORT) || 3001;
server.listen(port, function () {
  console.log('listening on *:' + port);
});
