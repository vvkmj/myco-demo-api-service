const hashFn = require("string-hash");

export function routingHashFn(hash: string | number): number {
	if(typeof hash !== 'string' && typeof hash !== 'number') {
		throw new Error('Input must be a string or number');
	}
	return hashFn(hash);
};