import { z } from 'zod';

// Zod probes for `new Function` to speed up validation. The page's Content-Security-Policy forbids
// it, and the browser reports every probe as a violation, so switch the probe off. This module is
// imported before any other, so it runs before the first schema is made.
z.config({ jitless: true });
