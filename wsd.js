// wsd.js - web socket client and server
// provides the bindings to web sockets

var exports = module.exports = {}

var os = require('os'),
    hostname = os.hostname();

var url = require('url');

var base_uri;
var registry;

function register_base_uri(uri, things) {
    base_uri = uri;
    registry = things;
}

// run the websocket server
var WebSocket = require('ws'),
    WebSocketServer = WebSocket.Server,
    wss = new WebSocketServer({
        port: 8080,
        path: '/webofthings'
    });

console.log('started web sockets server on port 8080');

var proxies = {};
var connections = {};
var pending = {};

function register_continuation(uri, method, context) {
    if (!pending[uri])
        pending[uri] = [];

    pending[uri] = {
        method: method,
        context: context
    };
}

// used to call continuations pending on a local thing being registered
function register_thing(thing) {
    var context, continuation, continuations = pending[thing._uri];

    console.log('wsd: registering thing ' + thing._uri);

    if (continuations) {
        for (var i = 0; i < continuations.length; ++i) {
            continuation = continuations[i];
            continuations.method(thing, continuation.context);
        }

        delete pending[thing._uri];
    }
}

function register_proxy(uri, ws) {
    uri = typeof uri == 'string' ? uri : uri.href;
    var id = url.parse(uri).path;

    console.log("wsd: registering proxy: " + id);
    if (!proxies[id])
        proxies[id] = [];

    proxies[id].push(ws);
}

// asynchronous because the thing may not yet have been created
function find_thing(uri, succeed, context) {
    var uri = url.resolve(base_uri, uri);
    var options = url.parse(uri);
    var uri = options.href;

    registry.find(uri,
        function(found) {
            succeed(found, context);
        },
        function(err) {
            console.log(err);
            options.hostname = 'localhost';
            uri = url.format(options);
            register_continuation(uri, method, context);
        }
    );
}

function connect(host, succeed, fail) {
    var ws = connections[host];

    if (ws) {
        succeed(ws); // reuse existing connection
    } else // create new connection
    {
        console.log('opening web socket connection with ' + host);
        ws = new WebSocket('ws://' + host + ':8080/webofthings');

        ws.on('open', function() {
            console.log('opened web socket connection with ' + host);
            connections[host] = ws;
            // now let other server know our hostname
            ws.send(JSON.stringify({
                host: os.hostname()
            }));
            succeed(ws);
        });

        ws.on('close', function() {
            delete connections[host];
        });

        ws.on('message', function(message, flags) {
            console.log("received message from server: " + host + " " + message);
            try {
                var obj = JSON.parse(message);
                dispatch(ws, obj);
            } catch (e) {
                console.log("Error in handling" + message + " - " + e);
            }
        });

        ws.on('error', function(e) {
            fail(e);
        });
    }
}

wss.on('connection', function(ws) {
    var host = null;

    ws.on('message', function(message) {
        console.log('received: ' + message);

        try {
            var obj = JSON.parse(message);
            dispatch(ws, obj);
        } catch (e) {
            console.log("Error in handling " + message + " - " + e);
        }
    });

    ws.on('close', function() {
        delete connections[host];
    });
});

function dispatch(ws, message) {
    if (message.host) {
        console.log('connection from host ' + message.host);
        var host = message.host;
        connections[host] = ws;
    } else if (message.proxy) {
        // register this ws connection as a proxy so
        // we can notify events and property updates
        register_proxy(message.proxy, ws);

        find_thing(message.proxy, function(thing) {
            var props = {};
            var names = thing._properties;

            for (var prop in names) {
                if (names.hasOwnProperty(prop) && prop.substr(0, 1) !== "_")
                    props[prop] = thing._values[prop];
            }

            // return state of properties
            props["_running"] = thing._running;

            var response = {
                uri: message.proxy,
                state: props
            };

            ws.send(JSON.stringify(response));
        });
    } else if (message.patch) {
        var uri = url.resolve(base_uri, message.uri);
        find_thing(uri, function(thing) {
            thing[message.patch] = message.data;

            // update other proxies for this thing
            notify(message, ws);
        });
    } else if (message.action) {
        var uri = url.resolve(base_uri, message.uri);
        find_thing(uri, function(thing) {
            var result = thing[message.action](message.data);

            if (result && message.call) {
                var response = {};
                response.uri = uri;
                response.call = message.call;
                response.data = result;
                ws.send(JSON.stringify(response));
            }
        });
    } else if (message.error) {
        console.log("received error message: " + error);
    } else {
        console.log("unknown message type: " + JSON.stringify(message));
        var response = {
            error: "unknown message type"
        };
        ws.send(JSON.stringify(response));
    }
}

// send message to all current connections with proxies for
// the same thing, but excluding the given client if provided
function notify(message, client) {
    var id = url.parse(message.uri).path;
    var connections = proxies[id];

    if (connections) {
        var notification = JSON.stringify(message);

        for (var i = 0; i < connections.length; ++i) {
            var ws = connections[i];

            if (client) {
                if (ws === client)
                    continue;
            }

            console.log("sending: " + notification);
            ws.send(notification);
        }
    }
}

exports.connect = connect;
exports.notify = notify;
exports.register_thing = register_thing;
exports.register_proxy = register_proxy;
exports.register_base_uri = register_base_uri;