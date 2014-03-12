/*

GET /note
GET /note/:id
POST /note
PUT /note/:id
DELETE /note/:id

*/
HTTP = Package.http && Package.http.HTTP || {};

var url = Npm.require('url');
var stream = Npm.require('stream');

// Primary local test scope
_methodHTTP = {};


_methodHTTP.methodHandlers = {};
_methodHTTP.methodTree = {};

// This could be changed eg. could allow larger data chunks than 1.000.000
// 5mb = 5 * 1024 * 1024 = 5242880;
_methodHTTP.maxDataLength = 5242880; //1e6;

_methodHTTP.nameFollowsConventions = function(name) {
  // Check that name is string, not a falsy or empty
  return name && name === '' + name && name !== '';
};


_methodHTTP.getNameList = function(name) {
  // Remove leading and trailing slashes and make command array
  name = name && name.replace(/^\//g, '') || ''; // /^\/|\/$/g
  // TODO: Get the format from the url - eg.: "/list/45.json" format should be
  // set in this function by splitting the last list item by . and have format
  // as the last item. How should we toggle:
  // "/list/45/item.name.json" and "/list/45/item.name"?
  // We would either have to check all known formats or allways determin the "."
  // as an extension. Resolving in "json" and "name" as handed format - the user
  // Could simply just add the format as a parametre? or be explicit about
  // naming
  return name && name.split('/') || [];
};

// Merge two arrays one containing keys and one values
_methodHTTP.createObject = function(keys, values) {
  var result = {};
  if (keys && values) {
    for (var i = 0; i < keys.length; i++) {
      result[keys[i]] = values[i] && decodeURIComponent(values[i]) || '';
    }
  }
  return result;
};

_methodHTTP.addToMethodTree = function(methodName) {
  var list = _methodHTTP.getNameList(methodName);
  var name = '/';
  // Contains the list of params names
  var params = [];
  var currentMethodTree = _methodHTTP.methodTree;

  for (var i = 0; i < list.length; i++) {
    var lastListItem = (i === list.length - 1);

    // get the key name
    var key = list[i];
    // Check if it expects a value
    if (key[0] === ':') {
      // This is a value
      params.push(key.slice(1));
      key = ':value';
    }
    name += key + '/';

    // Set the key into the method tree
    if (typeof currentMethodTree[key] === 'undefined') {
      currentMethodTree[key] = {};
    }

    // Dig deeper
    currentMethodTree = currentMethodTree[key];

  }

  if (_.isEmpty(currentMethodTree[':ref'])) {
    currentMethodTree[':ref'] = {
      name: name,
      params: params
    };
  }

  return currentMethodTree[':ref'];
};

// This method should be optimized for speed since its called on allmost every
// http call to the server so we return null as soon as we know its not a method
_methodHTTP.getMethod = function(name) {
  // Check if the
  if (!_methodHTTP.nameFollowsConventions(name)) {
    return null;
  }
  var list = _methodHTTP.getNameList(name);
  // Check if we got a correct list
  if (!list || !list.length) {
    return null;
  }
  // Set current refernce in the _methodHTTP.methodTree
  var currentMethodTree = _methodHTTP.methodTree;
  // Buffer for values to hand on later
  var values = [];
  // Iterate over the method name and check if its found in the method tree
  for (var i = 0; i < list.length; i++) {
    // get the key name
    var key = list[i];
    // We expect to find the key or :value if not we break
    if (typeof currentMethodTree[key] !== 'undefined' ||
            typeof currentMethodTree[':value'] !== 'undefined') {
      // We got a result now check if its a value
      if (typeof currentMethodTree[key] === 'undefined') {
        // Push the value
        values.push(key);
        // Set the key to :value to dig deeper
        key = ':value';
      }

    } else {
      // Break - method call not found
      return null;
    }

    // Dig deeper
    currentMethodTree = currentMethodTree[key];
  }

  // Extract reference pointer
  var reference = currentMethodTree && currentMethodTree[':ref'];
  if (typeof reference !== 'undefined') {
    return {
      name: reference.name,
      params: _methodHTTP.createObject(reference.params, values),
      handle: _methodHTTP.methodHandlers[reference.name]
    };
  } else {
    // Did not get any reference to the method
    return null;
  }
};

// This method retrieves the userId from the token and makes sure that the token
// is valid and not expired
_methodHTTP.getUserId = function() {
  var self = this;

  // // Get ip, x-forwarded-for can be comma seperated ips where the first is the
  // // client ip
  // var ip = self.req.headers['x-forwarded-for'] &&
  //         // Return the first item in ip list
  //         self.req.headers['x-forwarded-for'].split(',')[0] ||
  //         // or return the remoteAddress
  //         self.req.connection.remoteAddress;

  // Check authentication
  var userToken = self.query.token;

  // Check if we are handed strings
  try {
    userToken && check(userToken, String);
  } catch(err) {
    throw new Meteor.Error(404, 'Error user token and id not of type strings, Error: ' + (err.stack || err.message));
  }

  // Set the this.userId
  if (userToken) {
    // Look up user to check if user exists and is loggedin via token
    var user = Meteor.users.findOne({
        $or: [
          {'services.resume.loginTokens.hashedToken': Accounts._hashLoginToken(userToken)},
          {'services.resume.loginTokens.token': userToken}
        ]
      });
    // TODO: check 'services.resume.loginTokens.when' to have the token expire

    // Set the userId in the scope
    return user && user._id;
  }

  return null;
};


// Public interface for adding server-side http methods - if setting a method to
// 'false' it would actually remove the method (can be used to unpublish a method)
HTTP.methods = function(newMethods) {
  _.each(newMethods, function(func, name) {
    if (_methodHTTP.nameFollowsConventions(name)) {
      // Check if we got a function
      //if (typeof func === 'function') {
        var method = _methodHTTP.addToMethodTree(name);
        // The func is good
        if (typeof _methodHTTP.methodHandlers[method.name] !== 'undefined') {
          if (func === false) {
            // If the method is set to false then unpublish
            delete _methodHTTP.methodHandlers[method.name];
            // Delete the reference in the _methodHTTP.methodTree
            delete method.name;
            delete method.params;
          } else {
            // We should not allow overwriting - following Meteor.methods
            throw new Error('HTTP method "' + name + '" is already registered');
          }
        } else {
          // We could have a function or a object
          // The object could have:
          // '/test/': {
          //   auth: function() ... returning the userId using over default
          //
          //   method: function() ...
          //   or
          //   post: function() ...
          //   put:
          //   get:
          //   delete:
          // }

          /*
          We conform to the object format:
          {
            auth:
            post:
            put:
            get:
            delete:
          }
          This way we have a uniform reference
          */

          var uniObj = {};
          if (typeof func === 'function') {
            uniObj = {
              'auth': _methodHTTP.getUserId,
              'stream': false,
              'POST': func,
              'PUT': func,
              'GET': func,
              'DELETE': func
            };
          } else {
            uniObj = {
              'stream': func.stream || false,
              'auth': func.auth || _methodHTTP.getUserId,
              'POST': func.post || func.method,
              'PUT': func.put || func.method,
              'GET': func.get || func.method,
              'DELETE': func.delete || func.method
            };
          }

          // Registre the method
          _methodHTTP.methodHandlers[method.name] = uniObj; // func;

        }
      // } else {
      //   // We do require a function as a function to execute later
      //   throw new Error('HTTP.methods failed: ' + name + ' is not a function');
      // }
    } else {
      // We have to follow the naming spec defined in nameFollowsConventions
      throw new Error('HTTP.method "' + name + '" invalid naming of method');
    }
  });
};

var sendError = function(res, code, message) {
  res.writeHead(code);
  res.end(message);
};

// This handler collects the header data into either an object (if json) or the
// raw data. The data is passed to the callback
var requestHandler = function(req, res, callback) {
  if (typeof callback !== 'function') {
    return null;
  }

  // Container for buffers and a sum of the length
  var bufferData = [], dataLen = 0;

  // Extract the body
  req.on('data', function(data) {
    bufferData.push(data);
    dataLen += data.length;

    // We have to check the data length in order to spare the server
    if (dataLen > _methodHTTP.maxDataLength) {
      dataLen = 0;
      bufferData = [];
      // Flood attack or faulty client
      sendError(res, 413, 'Flood attack or faulty client');
      req.connection.destroy();
    }
  });

  // When message is ready to be passed on
  req.on('end', function() {
    if (res.finished) {
      return;
    }

    // Allow the result to be undefined if so
    var result;

    // If data found the work it - either buffer or json
    if (dataLen > 0) {
      result = new Buffer(dataLen);
      // Merge the chunks into one buffer
      for (var i = 0, ln = bufferData.length, pos = 0; i < ln; i++) {
        bufferData[i].copy(result, pos);
        pos += bufferData[i].length;
        delete bufferData[i];
      }
      // Check if we could be dealing with json
      if (result[0] == 0x7b && result[1] === 0x22) {
        try {
          // Convert the body into json and extract the data object
          result = EJSON.parse(result.toString());
        } catch(err) {
          // Could not parse so we return the raw data
        }
      }
    } else {
      // Result will be undefined
    }

    try {
      callback(result);
    } catch(err) {
      sendError(res, 500, 'Error in requestHandler callback, Error: ' + (err.stack || err.message) );
    }
  });

};

// This is the simplest handler - it simply passes req stream as data to the
// method
var streamHandler = function(req, res, callback) {
  try {
    callback();
  } catch(err) {
    sendError(res, 500, 'Error in requestHandler callback, Error: ' + (err.stack || err.message) );
  }
};

// Handle the actual connection
WebApp.connectHandlers.use(function(req, res, next) {

  // Check to se if this is a http method call
  var method = _methodHTTP.getMethod(req._parsedUrl.pathname);

  // If method is null then it wasn't and we pass the request along
  if (method === null) {
    return next();
  }

  var dataHandle = (method.handle.stream)?streamHandler:requestHandler;

  dataHandle(req, res, function(data) {
    // If methodsHandler not found or somehow the methodshandler is not a
    // function then return a 404
    if (typeof method.handle === 'undefined') {
      sendError(res, 404, 'Error HTTP method handler "' + method.name + '" is not found');
      return;
    }

    // Set fiber scope
    var fiberScope = {
      // Pointers to Request / Response
      req: req,
      res: res,
      // Request / Response helpers
      statusCode: 200,
      method: req.method,
      // Headers for response
      headers: {
        'Content-Type': 'text/html'  // Set default type
      },
      // Arguments
      data: data,
      query: req.query,
      params: method.params,
      // Method reference
      reference: method.name,
      methodObject: method.handle,
      // Streaming flags
      isReadStreaming: false,
      isWriteStreaming: false,
    };

    // Helper functions this scope
    Fiber = Npm.require('fibers');
    runServerMethod = Fiber(function(self) {
      // We fetch methods data from methodsHandler, the handler uses the this.addItem()
      // function to populate the methods, this way we have better check control and
      // better error handling + messages

      // The scope for the user methodObject callbacks
      var thisScope = {
        // The user whos id and token was used to run this method, if set/found
        userId: null,
        // The id of the data
        _id: null,
        // Set the query params ?token=1&id=2 -> { token: 1, id: 2 }
        query: self.query,
        // Set params /foo/:name/test/:id -> { name: '', id: '' }
        params: self.params,
        // Method GET, PUT, POST, DELETE
        method: self.method,
        // User agent
        userAgent: req.headers['user-agent'],
        // All request headers
        requestHeaders: req.headers,
        // Set the userId
        setUserId: function(id) {
          this.userId = id;
        },
        // We dont simulate / run this on the client at the moment
        isSimulation: false,
        // Run the next method in a new fiber - This is default at the moment
        unblock: function() {},
        // Set the content type in header, defaults to text/html?
        setContentType: function(type) {
          self.headers['Content-Type'] = type;
        },
        setStatusCode: function(code) {
          self.statusCode = code;
        },
        addHeader: function(key, value) {
          self.headers[key] = value;
        },
        createReadStream: function() {
          self.isReadStreaming = true;
          return req;
        },
        createWriteStream: function() {
          self.isWriteStreaming = true;
          return res;
        },
        // getData: function() {
        //   // XXX: TODO if we could run the request handler stuff eg.
        //   // in here in a fiber sync it could be cool - and the user did
        //   // not have to specify the stream=true flag?
        // }
      };

      var methodCall = self.methodObject[self.method];

      // If the method call is set for the POST/PUT/GET or DELETE then run the
      // respective methodCall if its a function
      if (typeof methodCall === 'function') {

        // Get the userId - This is either set as a method specific handler and
        // will allways default back to the builtin getUserId handler
        try {
          // Try to set the userId
          thisScope.userId = self.methodObject.auth.apply(self);
        } catch(err) {
          sendError(res, err.error, (err.message || err.stack));
          return;
        }

        // Get the result of the methodCall
        var result;
        // Get a result back to send to the client
        try {
          result = methodCall.apply(thisScope, [self.data]) || '';
        } catch(err) {
          if (err instanceof Meteor.Error) {
            // Return controlled error
            sendError(res, err.error, err.message);
          } else {
            // Return error trace - this is not intented
            sendError(res, 503, 'Error in method "' + self.reference + '", Error: ' + (err.stack || err.message) );
          }
          return;
        }

        // If OK / 200 then Return the result
        if (self.statusCode === 200) {
          // Set headers
          _.each(self.headers, function(value, key) {
            // If value is defined then set the header, this allows for unsetting
            // the default content-type
            if (typeof value !== 'undefined')
              res.setHeader(key, value);
          });

          // Return result
          var resultBuffer = new Buffer(result);

          // Check if user wants to overwrite content length for some reason?
          if (typeof self.headers['Content-Length'] === 'undefined') {
            self.headers['Content-Length'] = resultBuffer.length;
          }

          // Check if we allow and have a stream and the user is read streaming
          // Then
          var streamsWaiting = 1;

          // We wait until the user has finished reading
          if (self.isReadStreaming) {
            // console.log('Read stream');
            req.on('end', function() {
              streamsWaiting--;
              // If no streams are waiting
              if (streamsWaiting == 0 && !self.isWriteStreaming) {
                res.end(resultBuffer);
              }
            });

          } else {
            streamsWaiting--;
          }

          // We wait until the user has finished writing
          if (self.isWriteStreaming) {
            // console.log('Write stream');
          } else {
            // If we are done reading the buffer - eg. not streaming
            if (streamsWaiting == 0) res.end(resultBuffer);
          }


        } else {
          // Set headers
          _.each(self.headers, function(value, key) {
            // If value is defined then set the header, this allows for unsetting
            // the default content-type
            if (typeof value !== 'undefined')
              res.setHeader(key, value);
          });
          // Allow user to alter the status code and send a message
          sendError(res, self.statusCode, result);
        }

      } else {
        sendError(res, 404, 'Service not found');
      }


    });
    // Run http methods handler
    try {
      runServerMethod.run(fiberScope);
    } catch(err) {
      sendError(res, 500, 'Error running the server http method handler, Error: ' + (err.stack || err.message));
    }

  }); // EO Request handler


});
