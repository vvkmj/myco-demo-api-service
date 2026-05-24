import { ContainerClient } from "@azure/storage-blob";
import { BlobCheckpointStore } from "@azure/eventhubs-checkpointstore-blob";
import * as logger from '@motorq/logger';

export async function getBlobForCheckpointing(connectionString: string, blobName: string): Promise<BlobCheckpointStore> {
	blobName = blobName.trim().toLowerCase();

	if (!connectionString || !blobName) {
		throw new Error('Connection string and blob name must be provided for checkpointing');
	}

	logger.trackTrace({ message: `Initializing App Checkpointer Blob - "${blobName}"` });

	const blobContainerClient = new ContainerClient(connectionString, blobName);
	const store = new BlobCheckpointStore(blobContainerClient);
	logger.trackTrace({ message: 'Creating checkpoint blob if it doesnt exist' });
	await blobContainerClient.createIfNotExists();
	logger.trackTrace({ message: 'Completed App Checkpointer Blob Initialization' });
	return store;
}
