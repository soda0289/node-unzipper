var Stream = require('stream');
var Parse = require('./parse');
var duplexer = require('duplexer');
var BufferStream = require('./BufferStream');

function parseOne(match,opts) {
  var re = match instanceof RegExp ? match : (match && new RegExp(match));
  var found;

  var inStream = Stream.PassThrough({objectMode:true});
  var outStream = Stream.PassThrough();
  var transform = Stream.Transform({
      objectMode:true,
      transform: function(entry,e,cb) {
        console.log('TRANSFORMED');
        if (found || (re && !re.exec(entry.path))) {
          entry.autodrain();
          return cb();
        } else {
            found = true;
            out.emit('entry',entry);
            entry.on('error',function(e) {
                outStream.emit('error',e);
            });
            entry.pipe(outStream)
                .on('error',function(err) {
                cb(err);
                })
                .on('finish',function(d) {
                cb(null,d);
                });
        }
     }
  });


  inStream.pipe(Parse(opts))
    .on('error',function(err) {
        console.log('ERROR ERROR', err);
      outStream.emit('error',err);
    })
    .pipe(transform)
    .on('error',Object)  // Silence error as its already addressed in transform
    .on('finish',function() {
      if (!found)
        outStream.emit('error',new Error('PATTERN_NOT_FOUND'));
      else
        outStream.end();
    });

  var out = duplexer(inStream,outStream);
  out.buffer = function() {
    return BufferStream(outStream);
  };

  return out;
}

module.exports = parseOne;
