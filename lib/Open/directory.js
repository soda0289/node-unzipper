var binary = require('binary');
var PullStream = require('../PullStream');
var unzip = require('./unzip');
var BufferStream = require('../BufferStream');
var parseExtraField = require('../parseExtraField');
var Buffer = require('../Buffer');
var path = require('path');
var Writer = require('fstream').Writer;
var parseDateTime = require('../parseDateTime');

var signature = Buffer.alloc(4);
signature.writeUInt32LE(0x06054b50,0);

function getCrxHeader(source) {
  var sourceStream = source.stream(0).pipe(PullStream());

  return sourceStream.pull(4).then(function(data) {
    var signature = data.readUInt32LE(0);
    if (signature === 0x34327243) {
      var crxHeader;
      return sourceStream.pull(12).then(function(data) {
        crxHeader = binary.parse(data)
          .word32lu('version')
          .word32lu('pubKeyLength')
          .word32lu('signatureLength')
          .vars;
      }).then(function() {
        return sourceStream.pull(crxHeader.pubKeyLength +crxHeader.signatureLength);
      }).then(function(data) {
        crxHeader.publicKey = data.slice(0,crxHeader.pubKeyLength);
        crxHeader.signature = data.slice(crxHeader.pubKeyLength);
        crxHeader.size = 16 + crxHeader.pubKeyLength +crxHeader.signatureLength;
        return crxHeader;
      });
    }
  });
}

// Zip64 File Format Notes: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
function getZip64CentralDirectory(source, zip64CDL) {
  var d64loc = binary.parse(zip64CDL)
    .word32lu('signature')
    .word32lu('diskNumber')
    .word64lu('offsetToStartOfCentralDirectory')
    .word32lu('numberOfDisks')
    .vars;

  if (d64loc.signature != 0x07064b50) {
    throw new Error('invalid zip64 end of central dir locator signature (0x07064b50): 0x' + d64loc.signature.toString(16));
  }

  var dir64 = PullStream();
  source.stream(d64loc.offsetToStartOfCentralDirectory).pipe(dir64);

  return dir64.pull(56)
}

// Zip64 File Format Notes: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
function parseZip64DirRecord (dir64record) {
  var vars = binary.parse(dir64record)
    .word32lu('signature')
    .word64lu('sizeOfCentralDirectory')
    .word16lu('version')
    .word16lu('versionsNeededToExtract')
    .word32lu('diskNumber')
    .word32lu('diskStart')
    .word64lu('numberOfRecordsOnDisk')
    .word64lu('numberOfRecords')
    .word64lu('sizeOfCentralDirectory')
    .word64lu('offsetToStartOfCentralDirectory')
    .vars;

  if (vars.signature != 0x06064b50) {
    throw new Error('invalid zip64 end of central dir locator signature (0x06064b50): 0x0' + vars.signature.toString(16));
  }

  return vars
}

module.exports = async function centralDirectory(source, options) {
  var endDir = PullStream(),
      records = PullStream(),
      tailSize = (options && options.tailSize) || 80,
      sourceSize,
      crxHeader,
      startOffset,
      vars;

  if (options && options.crx)
    crxHeader = getCrxHeader(source);

  const size = await source.size();

  sourceSize = size;

  source.stream(Math.max(0,size-tailSize))
    .on('error', function (error) { endDir.emit('error', error) })
    .pipe(endDir);

  await endDir.pull(signature);

  const d = {
    directory: await endDir.pull(22),
    crxHeader: await crxHeader
  };
  var data = d.directory;

  startOffset = d.crxHeader && d.crxHeader.size || 0;

  vars = binary.parse(data)
    .word32lu('signature')
    .word16lu('diskNumber')
    .word16lu('diskStart')
    .word16lu('numberOfRecordsOnDisk')
    .word16lu('numberOfRecords')
    .word32lu('sizeOfCentralDirectory')
    .word32lu('offsetToStartOfCentralDirectory')
    .word16lu('commentLength')
    .vars;

  // Is this zip file using zip64 format? Use same check as Go:
  // https://github.com/golang/go/blob/master/src/archive/zip/reader.go#L503
  // For zip64 files, need to find zip64 central directory locator header to extract
  // relative offset for zip64 central directory record.
  if (vars.numberOfRecords == 0xffff|| vars.numberOfRecords == 0xffff ||
  vars.offsetToStartOfCentralDirectory == 0xffffffff) {

    // Offset to zip64 CDL is 20 bytes before normal CDR
    const zip64CDLSize = 20
    const zip64CDLOffset = sourceSize - (tailSize - endDir.match + zip64CDLSize)
    const zip64CDLStream = PullStream();

    source.stream(zip64CDLOffset).pipe(zip64CDLStream);

    const d = await zip64CDLStream.pull(zip64CDLSize)
    const dir64Record = await getZip64CentralDirectory(source, d);

    vars = parseZip64DirRecord(dir64record)
  } else {
    vars.offsetToStartOfCentralDirectory += startOffset;
  }

  source.stream(vars.offsetToStartOfCentralDirectory).pipe(records);

  vars.extract = async function(opts) {
    if (!opts || !opts.path) throw new Error('PATH_MISSING');
    const files = await vars.files;
    const promises = files.map(function(entry) {
      if (entry.type == 'Directory') return;

      // to avoid zip slip (writing outside of the destination), we resolve
      // the target path, and make sure it's nested in the intended
      // destination, or not extract it otherwise.
      var extractPath = path.join(opts.path, entry.path);
      if (extractPath.indexOf(opts.path) != 0) {
        return;
      }
      var writer = opts.getWriter ? opts.getWriter({path: extractPath}) :  Writer({ path: extractPath });

      return new Promise(function(resolve, reject) {
        entry.stream(opts.password)
          .on('error',reject)
          .pipe(writer)
          .on('close',resolve)
          .on('error',reject);
      });
    });

    await Promise.all(promises);
  };

  vars.files = [];

  for (const a of Array(vars.numberOfRecords)) {
    const data = await records.pull(46);
    const file = binary.parse(data)
        .word32lu('signature')
        .word16lu('versionMadeBy')
        .word16lu('versionsNeededToExtract')
        .word16lu('flags')
        .word16lu('compressionMethod')
        .word16lu('lastModifiedTime')
        .word16lu('lastModifiedDate')
        .word32lu('crc32')
        .word32lu('compressedSize')
        .word32lu('uncompressedSize')
        .word16lu('fileNameLength')
        .word16lu('extraFieldLength')
        .word16lu('fileCommentLength')
        .word16lu('diskNumber')
        .word16lu('internalFileAttributes')
        .word32lu('externalFileAttributes')
        .word32lu('offsetToLocalFileHeader')
        .vars;

    file.offsetToLocalFileHeader += startOffset;
    file.lastModifiedDateTime = parseDateTime(file.lastModifiedDate, file.lastModifiedTime);

    const fileNameBuffer = await records.pull(file.fileNameLength);
    file.pathBuffer = fileNameBuffer;
    file.path = fileNameBuffer.toString('utf8');
    file.isUnicode = file.flags & 0x11;
    const extraField = await  records.pull(file.extraFieldLength);
    file.extra = parseExtraField(extraField, file);
    const comment = await  records.pull(file.fileCommentLength);
    file.comment = comment;
    file.type = (file.uncompressedSize === 0 && /[\/\\]$/.test(file.path)) ? 'Directory' : 'File';
    file.stream = function(_password) {
        return unzip(source, file.offsetToLocalFileHeader,_password, file);
    };
    file.buffer = function(_password) {
        return BufferStream(file.stream(_password));
    };

    vars.files.push(file);
  }

  return vars;
}
