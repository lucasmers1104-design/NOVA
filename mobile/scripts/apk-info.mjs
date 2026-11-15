// What a built APK really is: its version, its signing certificate and the permissions
// Android will see after all libraries were merged in. Optionally compares the signer
// with a second APK.
//
//   node scripts/apk-info.mjs path/to/app.apk
//   node scripts/apk-info.mjs path/to/new.apk ../releases/NOVA-Companion.apk
//
// Android installs an update only if it is signed with the same key as the installed
// app. Run the second form before publishing a build: it exits with 1 if the new APK
// was signed with another key, which every phone would refuse ("Paket steht in Konflikt").
//
// Reads the zip, the binary manifest and the APK Signing Block (scheme v2/v3) directly,
// so it needs neither the Android SDK nor Java. Read-only.
import { createHash, X509Certificate } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const SCHEMES = new Map([
  [0x7109871a, "v2"],
  [0xf05368c0, "v3"],
  [0x1b93ad61, "v3.1"],
]);

function open(file) {
  const fd = openSync(file, "r");
  const size = fstatSync(fd).size;
  const read = (position, length) => {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, position);
    return buffer;
  };
  // The zip's end record sits in the last 64 KB; it says where the central directory is.
  const tailLength = Math.min(size, 65_557);
  const tail = read(size - tailLength, tailLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0 && end < 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) end = i;
  }
  if (end < 0) throw new Error(`${file} is not an APK (no zip end record)`);
  return { fd, read, entries: tail.readUInt16LE(end + 10), directorySize: tail.readUInt32LE(end + 12), directory: tail.readUInt32LE(end + 16) };
}

/** The bytes of one file in the zip. */
function entry(apk, name) {
  const directory = apk.read(apk.directory, apk.directorySize);
  for (let p = 0, i = 0; i < apk.entries; i++) {
    const [method, packed, nameLength, extraLength, commentLength, local] = [directory.readUInt16LE(p + 10), directory.readUInt32LE(p + 20), directory.readUInt16LE(p + 28), directory.readUInt16LE(p + 30), directory.readUInt16LE(p + 32), directory.readUInt32LE(p + 42)];
    if (directory.toString("utf8", p + 46, p + 46 + nameLength) === name) {
      const header = apk.read(local, 30);
      const data = apk.read(local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), packed);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the APK`);
}

/** Start tags of Android's binary XML, each with its attributes by name. */
function tags(xml) {
  const strings = [];
  const found = [];
  for (let offset = 8; offset < xml.length; ) {
    const [kind, header, size] = [xml.readUInt16LE(offset), xml.readUInt16LE(offset + 2), xml.readUInt32LE(offset + 4)];
    if (kind === 0x0001) {
      const [count, flags, start] = [xml.readUInt32LE(offset + 8), xml.readUInt32LE(offset + 16), xml.readUInt32LE(offset + 20)];
      for (let i = 0; i < count; i++) {
        let at = offset + start + xml.readUInt32LE(offset + header + 4 * i);
        if (flags & 0x100) {
          // UTF-8: the length in characters, then the length in bytes; each one or two bytes long.
          at += xml[at] & 0x80 ? 2 : 1;
          let length = xml[at++];
          if (length & 0x80) length = ((length & 0x7f) << 8) | xml[at++];
          strings.push(xml.toString("utf8", at, at + length));
        } else {
          let length = xml.readUInt16LE(at);
          at += 2;
          if (length & 0x8000) {
            length = ((length & 0x7fff) << 16) | xml.readUInt16LE(at);
            at += 2;
          }
          strings.push(xml.toString("utf16le", at, at + 2 * length));
        }
      }
    } else if (kind === 0x0102) {
      const [first, each, count] = [xml.readUInt16LE(offset + 24), xml.readUInt16LE(offset + 26), xml.readUInt16LE(offset + 28)];
      const attributes = {};
      for (let i = 0; i < count; i++) {
        const at = offset + 16 + first + i * each;
        const [raw, type, value] = [xml.readUInt32LE(at + 8), xml[at + 15], xml.readUInt32LE(at + 16)];
        attributes[strings[xml.readUInt32LE(at + 4)]] = raw !== 0xffffffff ? strings[raw] : type === 3 ? strings[value] : value;
      }
      found.push({ name: strings[xml.readUInt32LE(offset + 20)], attributes });
    }
    offset += size;
  }
  return found;
}

/** The first signer's certificate of the newest signature scheme in the file. */
function signingCertificate(apk, file) {
  // The signing block ends right before the central directory, with its size and a magic text.
  const footer = apk.read(apk.directory - 24, 24);
  if (footer.subarray(8).toString("latin1") !== "APK Sig Block 42") throw new Error(`${file} has no APK signing block`);
  const blockSize = Number(footer.readBigUInt64LE(0));
  const block = apk.read(apk.directory - blockSize - 8, blockSize + 8);
  let found = null;
  for (let position = 8; position < block.length - 24; ) {
    const length = Number(block.readBigUInt64LE(position));
    const scheme = SCHEMES.get(block.readUInt32LE(position + 8));
    const value = block.subarray(position + 12, position + 8 + length);
    position += 8 + length;
    if (!scheme) continue;
    // signers → first signer → signed data → digests (skipped) → certificates → first certificate
    let p = 12;
    p += 4 + value.readUInt32LE(p);
    p += 4;
    found = { scheme, der: value.subarray(p + 4, p + 4 + value.readUInt32LE(p)) };
  }
  if (!found) throw new Error(`${file} carries no v2 or v3 signature`);
  return found;
}

function describe(file, withPermissions) {
  const apk = open(file);
  try {
    const manifest = tags(entry(apk, "AndroidManifest.xml"));
    const app = manifest.find((tag) => tag.name === "manifest")?.attributes ?? {};
    const { scheme, der } = signingCertificate(apk, file);
    const fingerprint = createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g).join(":");
    console.log(`${file}`);
    console.log(`  ${app.package} ${app.versionName} (versionCode ${app.versionCode})`);
    console.log(`  Signatur ${scheme}, SHA-256 ${fingerprint}`);
    console.log(`  ${new X509Certificate(der).subject.replace(/\n/g, ", ")}`);
    if (withPermissions) {
      console.log("  Berechtigungen:");
      for (const tag of manifest.filter((each) => each.name === "uses-permission")) {
        console.log(`    ${tag.attributes.name}${tag.attributes.maxSdkVersion ? ` (bis API ${tag.attributes.maxSdkVersion})` : ""}`);
      }
    }
    return { fingerprint, versionCode: Number(app.versionCode) };
  } finally {
    closeSync(apk.fd);
  }
}

const files = process.argv.slice(2);
if (files.length < 1 || files.length > 2) {
  console.error("Aufruf: node scripts/apk-info.mjs <app.apk> [veroeffentlichte.apk]");
  process.exit(2);
}
const [fresh, published] = files.map((file, i) => describe(file, i === 0));
if (published) {
  const sameKey = fresh.fingerprint === published.fingerprint;
  console.log(sameKey ? "Gleicher Schlüssel: Android nimmt die erste als Update der zweiten an." : "ANDERER SCHLÜSSEL: Android lehnt die erste als Update der zweiten ab.");
  if (fresh.versionCode < published.versionCode) console.log(`Achtung: versionCode ${fresh.versionCode} ist kleiner als ${published.versionCode}; Android lehnt das als Rückschritt ab.`);
  process.exit(sameKey ? 0 : 1);
}
