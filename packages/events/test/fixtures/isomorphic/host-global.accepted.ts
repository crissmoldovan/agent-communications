// Accepted: keys, members and types that share a host global's name are not the global.
const options = { process: 1, fetch: 2, Date: 3 };

export const total = options.process + options.fetch + options.Date;
export type Clock = typeof Date;
