// File checks without blocking the extension host.
import * as fs from 'fs';

/** Whether a path exists. */
const exists = (p: string): Promise<boolean> =>
  fs.promises.access(p).then(
    () => true,
    () => false
  );

export { exists };
