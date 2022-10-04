import { BN } from 'bn.js';
import { baseDecode, baseEncode } from 'borsh';
import { Connection } from './connection';
import { ErrorContext, TypedError } from './providers';
import { AccessKeyView, AccessKeyViewRaw, FinalExecutionOutcome } from './providers/provider';
import { Action, SignedTransaction, signTransaction } from './transaction';
import { logWarning } from './utils/errors';
import { PublicKey } from './utils/key_pair';
import exponentialBackoff from './utils/exponential-backoff';
import { parseResultError, parseRpcError, ServerError } from './utils/rpc_errors';

// Default number of retries with different nonce before giving up on a transaction.
const TX_NONCE_RETRY_NUMBER = 12;

// Default wait until next retry in millis.
const TX_NONCE_RETRY_WAIT = 500;

// Exponential back off for waiting to retry.
const TX_NONCE_RETRY_WAIT_BACKOFF = 1.5;

/**
 * Options used to initiate sining and sending transactions
 */
export interface SignAndSendTransactionOptions {
    receiverId: string;
    actions: Action[];
    /**
     * Metadata to send the NEAR Wallet if using it to sign transactions.
     * @see {@link RequestSignTransactionsOptions}
     */
    walletMeta?: string;
    /**
     * Callback url to send the NEAR Wallet if using it to sign transactions.
     * @see {@link RequestSignTransactionsOptions}
     */
    walletCallbackUrl?: string;
    returnError?: boolean;
}

interface ReceiptLogWithFailure {
    receiptIds: [string];
    logs: [string];
    failure: ServerError;
}

export class TransactionSender {
    readonly connection: Connection;
    readonly accountId: string;
    accessKeyByPublicKeyCache: { [key: string]: AccessKeyView } = {};

    constructor(connection: Connection, accountId: string) {
        this.connection = connection;
        this.accountId = accountId;
    }

    /**
     * Create a signed transaction which can be broadcast to the network
     * @param receiverId NEAR account receiving the transaction
     * @param actions list of actions to perform as part of the transaction
     * @see {@link providers/json-rpc-provider!JsonRpcProvider#sendTransaction | JsonRpcProvider.sendTransaction}
     */
    protected async signTransaction(receiverId: string, actions: Action[]): Promise<[Uint8Array, SignedTransaction]> {
        const accessKeyInfo = await this.findAccessKey(receiverId, actions);
        if (!accessKeyInfo) {
            throw new TypedError(`Can not sign transactions for account ${this.accountId} on network ${this.connection.networkId}, no matching key pair exists for this account`, 'KeyNotFound');
        }
        const { accessKey } = accessKeyInfo;

        const block = await this.connection.provider.block({ finality: 'final' });
        const blockHash = block.header.hash;

        const nonce = accessKey.nonce.add(new BN(1));
        return await signTransaction(
            receiverId, nonce, actions, baseDecode(blockHash), this.connection.signer, this.accountId, this.connection.networkId
        );
    }

    /**
     * Sign a transaction to preform a list of actions and broadcast it using the RPC API.
     * @see {@link providers/json-rpc-provider!JsonRpcProvider#sendTransaction | JsonRpcProvider.sendTransaction}
     */
    protected async signAndSendTransaction({ receiverId, actions, returnError }: SignAndSendTransactionOptions): Promise<FinalExecutionOutcome> {
        let txHash, signedTx;
        // TODO: TX_NONCE (different constants for different uses of exponentialBackoff?)
        const result = await exponentialBackoff(TX_NONCE_RETRY_WAIT, TX_NONCE_RETRY_NUMBER, TX_NONCE_RETRY_WAIT_BACKOFF, async () => {
            [txHash, signedTx] = await this.signTransaction(receiverId, actions);
            const publicKey = signedTx.transaction.publicKey;

            try {
                return await this.connection.provider.sendTransaction(signedTx);
            } catch (error) {
                if (error.type === 'InvalidNonce') {
                    logWarning(`Retrying transaction ${receiverId}:${baseEncode(txHash)} with new nonce.`);
                    delete this.accessKeyByPublicKeyCache[publicKey.toString()];
                    return null;
                }
                if (error.type === 'Expired') {
                    logWarning(`Retrying transaction ${receiverId}:${baseEncode(txHash)} due to expired block hash`);
                    return null;
                }

                error.context = new ErrorContext(baseEncode(txHash));
                throw error;
            }
        });
        if (!result) {
            // TODO: This should have different code actually, as means "transaction not submitted for sure"
            throw new TypedError('nonce retries exceeded for transaction. This usually means there are too many parallel requests with the same access key.', 'RetriesExceeded');
        }

        const flatLogs = [result.transaction_outcome, ...result.receipts_outcome].reduce((acc, it) => {
            if (it.outcome.logs.length ||
                (typeof it.outcome.status === 'object' && typeof it.outcome.status.Failure === 'object')) {
                return acc.concat({
                    'receiptIds': it.outcome.receipt_ids,
                    'logs': it.outcome.logs,
                    'failure': typeof it.outcome.status.Failure != 'undefined' ? parseRpcError(it.outcome.status.Failure) : null
                });
            } else return acc;
        }, []);
        this.printLogsAndFailures(signedTx.transaction.receiverId, flatLogs);

        // Should be falsy if result.status.Failure is null
        if (!returnError && typeof result.status === 'object' && typeof result.status.Failure === 'object'  && result.status.Failure !== null) {
            // if error data has error_message and error_type properties, we consider that node returned an error in the old format
            if (result.status.Failure.error_message && result.status.Failure.error_type) {
                throw new TypedError(
                    `Transaction ${result.transaction_outcome.id} failed. ${result.status.Failure.error_message}`,
                    result.status.Failure.error_type);
            } else {
                throw parseResultError(result);
            }
        }
        // TODO: if Tx is Unknown or Started.
        return result;
    }

    /**
     * Finds the {@link providers/provider!AccessKeyView} associated with the accounts {@link utils/key_pair!PublicKey} stored in the {@link key_stores/keystore!KeyStore}.
     *
     * @todo Find matching access key based on transaction (i.e. receiverId and actions)
     *
     * @param receiverId currently unused (see todo)
     * @param actions currently unused (see todo)
     * @returns `{ publicKey PublicKey; accessKey: AccessKeyView }`
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async findAccessKey(receiverId: string, actions: Action[]): Promise<{ publicKey: PublicKey; accessKey: AccessKeyView }> {
        // TODO: Find matching access key based on transaction (i.e. receiverId and actions)
        const publicKey = await this.connection.signer.getPublicKey(this.accountId, this.connection.networkId);
        if (!publicKey) {
            throw new TypedError(`no matching key pair found in ${this.connection.signer}`, 'PublicKeyNotFound');
        }

        const cachedAccessKey = this.accessKeyByPublicKeyCache[publicKey.toString()];
        if (cachedAccessKey !== undefined) {
            return { publicKey, accessKey: cachedAccessKey };
        }

        try {
            const rawAccessKey = await this.connection.provider.query<AccessKeyViewRaw>({
                request_type: 'view_access_key',
                account_id: this.accountId,
                public_key: publicKey.toString(),
                finality: 'optimistic'
            });

            // store nonce as BN to preserve precision on big number
            const accessKey = {
                ...rawAccessKey,
                nonce: new BN(rawAccessKey.nonce),
            };
            // this function can be called multiple times and retrieve the same access key
            // this checks to see if the access key was already retrieved and cached while
            // the above network call was in flight. To keep nonce values in line, we return
            // the cached access key.
            if (this.accessKeyByPublicKeyCache[publicKey.toString()]) {
                return { publicKey, accessKey: this.accessKeyByPublicKeyCache[publicKey.toString()] };
            }

            this.accessKeyByPublicKeyCache[publicKey.toString()] = accessKey;
            return { publicKey, accessKey };
        } catch (e) {
            if (e.type == 'AccessKeyDoesNotExist') {
                return null as any;
            }

            throw e;
        }
    }

    /** @hidden */
    protected printLogsAndFailures(contractId: string, results: [ReceiptLogWithFailure]) {
        if (!process.env['NEAR_NO_LOGS']) {
            for (const result of results) {
                console.log(`Receipt${result.receiptIds.length > 1 ? 's' : ''}: ${result.receiptIds.join(', ')}`);
                this.printLogs(contractId, result.logs, '\t');
                if (result.failure) {
                    console.warn(`\tFailure [${contractId}]: ${result.failure}`);
                }
            }
        }
    }

    /** @hidden */
    protected printLogs(contractId: string, logs: string[], prefix = '') {
        if (!process.env['NEAR_NO_LOGS']) {
            for (const log of logs) {
                console.log(`${prefix}Log [${contractId}]: ${log}`);
            }
        }
    }
}