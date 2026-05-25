import net from 'net';

export interface FtpConfig {
  host: string;
  port?: number;
  user: string;
  pass: string;
  path: string; // e.g. /public_html or /var/www/html
}

/**
 * Pure-JS passive FTP client over standard sockets.
 * Uploads a text file to a specified remote path.
 */
export function uploadVerificationKeyViaFtp(config: FtpConfig, filename: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const host = config.host;
    const port = config.port || 21;
    const user = config.user;
    const pass = config.pass;
    const remotePath = config.path.endsWith('/') ? `${config.path}${filename}` : `${config.path}/${filename}`;

    const controlSocket = net.connect({ host, port });
    controlSocket.setEncoding('utf8');

    let state = 'CONNECTING';
    let dataSocket: net.Socket | null = null;
    let dataBuffer = Buffer.from(content, 'utf8');

    const cleanUp = () => {
      try { controlSocket.destroy(); } catch {}
      try { dataSocket?.destroy(); } catch {}
    };

    controlSocket.on('error', (err) => {
      cleanUp();
      reject(new Error(`FTP Control socket error: ${err.message}`));
    });

    controlSocket.on('data', (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString('utf8');
      const lines = str.split('\r\n').filter(Boolean);
      for (const line of lines) {
        const code = parseInt(line.slice(0, 3));
        const message = line.slice(4);

        switch (state) {
          case 'CONNECTING':
            if (code === 220) {
              state = 'USER';
              controlSocket.write(`USER ${user}\r\n`);
            }
            break;

          case 'USER':
            if (code === 331) {
              state = 'PASS';
              controlSocket.write(`PASS ${pass}\r\n`);
            } else if (code === 230) {
              // Direct login, skip password
              state = 'TYPE';
              controlSocket.write('TYPE I\r\n');
            }
            break;

          case 'PASS':
            if (code === 230) {
              state = 'TYPE';
              controlSocket.write('TYPE I\r\n');
            } else {
              cleanUp();
              reject(new Error(`FTP login failed: ${line}`));
            }
            break;

          case 'TYPE':
            if (code === 200) {
              state = 'PASV';
              controlSocket.write('PASV\r\n');
            } else {
              cleanUp();
              reject(new Error(`FTP failed to set binary type: ${line}`));
            }
            break;

          case 'PASV':
            if (code === 227) {
              // Parse passive port entering string e.g. "227 Entering Passive Mode (192,168,1,2,192,5)"
              const match = message.match(/\(([^)]+)\)/);
              if (!match) {
                cleanUp();
                reject(new Error(`FTP failed to parse PASV mode details: ${line}`));
                return;
              }
              const parts = match[1].split(',').map(Number);
              const dataIp = parts.slice(0, 4).join('.');
              const dataPort = parts[4] * 256 + parts[5];

              state = 'STOR';

              // Establish TCP data socket connection
              dataSocket = net.connect({ host: dataIp, port: dataPort }, () => {
                controlSocket.write(`STOR ${remotePath}\r\n`);
              });

              dataSocket.on('error', (err) => {
                cleanUp();
                reject(new Error(`FTP Data socket error: ${err.message}`));
              });
            } else {
              cleanUp();
              reject(new Error(`FTP failed to enter passive mode: ${line}`));
            }
            break;

          case 'STOR':
            if (code === 150 || code === 125) {
              state = 'TRANSFER';
              if (dataSocket) {
                dataSocket.write(dataBuffer, () => {
                  dataSocket?.end();
                });
              }
            } else {
              cleanUp();
              reject(new Error(`FTP STOR rejected: ${line}`));
            }
            break;

          case 'TRANSFER':
            if (code === 226 || code === 250) {
              state = 'QUIT';
              controlSocket.write('QUIT\r\n');
            } else {
              cleanUp();
              reject(new Error(`FTP upload transfer failed: ${line}`));
            }
            break;

          case 'QUIT':
            if (code === 221) {
              cleanUp();
              resolve();
            }
            break;
        }
      }
    });
  });
}
