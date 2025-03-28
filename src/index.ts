import { ClientOptions, Cloudflare } from 'cloudflare';
import { AAAARecord, ARecord } from 'cloudflare/src/resources/dns/records.js';
type AddressableRecord = AAAARecord | ARecord;

class HttpError extends Error {
	constructor(public statusCode: number, message: string) {
		super(message);
		this.name = 'HttpError';
	}
}

function constructClientOptions(request: Request): ClientOptions {
	const authorization = request.headers.get('Authorization');
	if (!authorization) {
		throw new HttpError(401, 'API token missing.');
	}

	const [, data] = authorization.split(' ');
	const decoded = atob(data);
	const index = decoded.indexOf(':');

	if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
		throw new HttpError(401, 'Invalid API key or token.');
	}

	return {
		apiEmail: decoded.substring(0, index),
		apiToken: decoded.substring(index + 1),
	};
}

function constructDNSRecords(request: Request): AddressableRecord[] {
	const url = new URL(request.url);
	const params = url.searchParams;
	let ip = params.get('ip') || params.get('myip');
	const hostnames = params.get('hostname');

	if (ip === null || ip === undefined) {
		throw new HttpError(422, 'The "ip" parameter is required and cannot be empty. Specify ip=auto to use the client IP.');
	} else if (ip == 'auto') {
		ip = request.headers.get('CF-Connecting-IP');
		if (ip === null) {
			throw new HttpError(500, 'Request asked for ip=auto but client IP address cannot be determined.');
		}
	}

	if (hostnames === null || hostnames === undefined) {
		throw new HttpError(422, 'The "hostname" parameter is required and cannot be empty.');
	}

	// Split hostnames by comma
	const records: AddressableRecord[] = [];
	for (const hostname of hostnames.split(',')) {
		const record: AddressableRecord = {
			content: ip,
			name: hostname,
			type: ip.includes('.') ? 'A' : 'AAAA',
			ttl: 1,
		};

		records.push(record);
	}

	return records;
}

async function update(clientOptions: ClientOptions, newRecords: AddressableRecord[]): Promise<Response> {
	const cloudflare = new Cloudflare(clientOptions);

	const tokenStatus = (await cloudflare.user.tokens.verify()).status;
	if (tokenStatus !== 'active') {
		throw new HttpError(401, 'This API Token is ' + tokenStatus);
	}

	const zones = (await cloudflare.zones.list()).result;
	if (zones.length === 0) {
		throw new HttpError(400, 'No zones found! You must supply an API Token scoped to a single zone.');
	}

	for (const newRecord of newRecords) {
		for (const zone of zones) {
			const records = (
				await cloudflare.dns.records.list({
					zone_id: zone.id,
					name: newRecord.name as any,
					type: newRecord.type,
				})
			).result;

			if (records.length > 1) {
				throw new HttpError(400, 'More than one matching record found!');
			} else if (records.length === 0 || records[0].id === undefined) {
				console.log('No record found! You must first manually create the record.');
				continue;
			}

			// Extract current properties
			const currentRecord = records[0] as AddressableRecord;
			const proxied = currentRecord.proxied ?? false; // Default to `false` if `proxied` is undefined
			const comment = currentRecord.comment;

			await cloudflare.dns.records.update(records[0].id, {
				content: newRecord.content,
				zone_id: zone.id,
				name: newRecord.name as any,
				type: newRecord.type,
				proxied, // Pass the existing "proxied" status
				comment, // Pass the existing "comment"
			});

			console.log('DNS record for ' + newRecord.name + '(' + newRecord.type + ') updated successfully to ' + newRecord.content);
		}
	}

	return new Response('OK', { status: 200 });
}

export default {
	async fetch(request): Promise<Response> {
		console.log('Requester IP: ' + request.headers.get('CF-Connecting-IP'));
		console.log(request.method + ': ' + request.url);
		console.log('Body: ' + (await request.text()));

		try {
			// Construct client options and DNS record
			const clientOptions = constructClientOptions(request);
			const records = constructDNSRecords(request);

			// Run the update function
			return await update(clientOptions, records);
		} catch (error) {
			if (error instanceof HttpError) {
				console.log('Error updating DNS record: ' + error.message);
				return new Response(error.message, { status: error.statusCode });
			} else {
				console.log('Error updating DNS record: ' + error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}
	},
} satisfies ExportedHandler<Env>;
