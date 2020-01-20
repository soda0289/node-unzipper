var Stream = require('stream');
var Buffer = require('./Buffer');

module.exports = function(entry) {
  return new Promise(function(resolve,reject) {
    var buffer = Buffer.from(''),
        bufferStream = Stream.Transform()
          .on('finish',function() {
            resolve(buffer);
          })
          .on('error',reject);
        
    bufferStream._transform = function(d,e,cb) {
      buffer = Buffer.concat([buffer,d]);
      cb();
    };
    entry.on('error',reject)
      .pipe(bufferStream);
  });
};
