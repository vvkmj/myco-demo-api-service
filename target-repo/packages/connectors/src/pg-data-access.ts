import knex, { Knex } from 'knex';

interface PgDataAccessParams {
	client: 'pg',
	connection: Knex.PgConnectionConfig,
	pool: Knex.PoolConfig,
	knexConfig?: Knex.Config
}

export class PgDataAccess {
	private static instanceMap: Record<string, PgDataAccess> = {};
	private knex: any;

	public static getInstance(instanceKey: string = 'default', params: any = {}): PgDataAccess {
		if (PgDataAccess.instanceMap[instanceKey] == null || PgDataAccess.instanceMap[instanceKey] === undefined) {
			PgDataAccess.instanceMap[instanceKey] = new PgDataAccess(params);
		}
		return PgDataAccess.instanceMap[instanceKey];
	}

	constructor(params: PgDataAccessParams) {
		this.knex = knex({
			...params.knexConfig,
			client: 'pg',
			connection: params.connection,
			pool: params.pool,
		});
	}

	private static getRowsFromResponses(responses: any[]): any[] {
		return responses.map((response) => response.rows);
	}

	public async executeQuery(query: string, params: any): Promise<any> {
		const response = await this.knex.raw(query, params);
		return response.rows;
	}

	public async executeTransaction(queries: string[], params: any[]): Promise<any> {
		const response = await this.knex.transaction(async (trx: any) => {
			return Promise.all(queries.map(async (query, index) => {
				return await trx.raw(query, params[index]);
			}));
		});
		return PgDataAccess.getRowsFromResponses(response);
	}

	public getKnex(): Knex {
		return this.knex;
	}

	public excecuteRaw(sql: string): Promise<any> {
		return this.knex.raw(sql);
	}

	public async closeConnection(): Promise<any> {
		return this.knex.destroy();
	}
}
