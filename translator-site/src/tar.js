'use strict';
// 最小 ustar 打包器：用于生成“只含 public 许可素材”的案例下载包。

function tarEntry(name, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 99), 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(buf.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  header.write('        ', 148);            // checksum 占位（8 个空格）
  header.write('0', 156);                  // typeflag: 普通文件
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (buf.length % 512)) % 512;
  return Buffer.concat([header, buf, pad ? Buffer.alloc(pad) : Buffer.alloc(0)]);
}

function tarBall(files) {
  return Buffer.concat([...files.map(f => tarEntry(f.name, f.data)), Buffer.alloc(1024)]);
}

module.exports = { tarBall };
