import BN from 'bn.js';

import {
    transfer,
    createAccount,
    deployContract,
    addKey,
    functionCall,
    fullAccessKey,
    functionCallAccessKey,
    deleteKey,
    stake,
    deleteAccount,
    stringifyJsonOrBytes
} from './transaction';
import { TransactionSender } from './transaction_sender';
import { FinalExecutionOutcome } from './providers';
import {
    ViewStateResult,
    AccountView,
    CodeResult,
    AccessKeyList,
    AccessKeyInfoView,
    FunctionCallPermissionView,
    BlockReference
} from './providers/provider';
import { Connection } from './connection';
import { PublicKey } from './utils/key_pair';
import { PositionalArgsError } from './utils/errors';
import { DEFAULT_FUNCTION_CALL_GAS, EMPTY_CONTRACT_HASH } from './constants';
import { TransactionBuilder } from './transaction_builder';

export interface AccountBalance {
    total: string;
    stateStaked: string;
    staked: string;
    available: string;
}

export interface AccountAuthorizedApp {
    contractId: string;
    amount: string;
    publicKey: string;
}

/**
 * Options used to initiate a function call (especially a change function call)
 * @see {@link account!Account#viewFunction} to initiate a view function call
 */
export interface FunctionCallOptions {
    /** The NEAR account id where the contract is deployed */
    contractId: string;
    /** The name of the method to invoke */
    methodName: string;
    /**
     * named arguments to pass the method `{ messageText: 'my message' }`
     */
    args?: object;
    /** max amount of gas that method call can use */
    gas?: BN;
    /** amount of NEAR (in yoctoNEAR) to send together with the call */
    attachedDeposit?: BN;
    /**
     * Convert input arguments into bytes array.
     */
    stringify?: (input: any) => Buffer;
    /**
     * Is contract from JS SDK, automatically encodes args from JS SDK to binary.
     */
    jsContract?: boolean;
}

export interface ChangeFunctionCallOptions extends FunctionCallOptions {
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
}
export interface ViewFunctionCallOptions extends FunctionCallOptions { 
    parse?: (response: Uint8Array) => any; 
    blockQuery?: BlockReference; 
}

interface StakedBalance {
    validatorId: string;
    amount?: string;
    error?: string;
}

interface ActiveDelegatedStakeBalance {
    stakedValidators: StakedBalance[];
    failedValidators: StakedBalance[];
    total: BN | string;
}

function parseJsonFromRawResponse(response: Uint8Array): any {
    return JSON.parse(Buffer.from(response).toString());
}

function bytesJsonStringify(input: any): Buffer {
    return Buffer.from(JSON.stringify(input));
}

/**
 * This class provides common account related RPC calls including signing transactions with a {@link utils/key_pair!KeyPair}.
 *
 * @hint Use {@link walletAccount!WalletConnection} in the browser to redirect to [NEAR Wallet](https://wallet.near.org/) for Account/key management using the {@link key_stores/browser_local_storage_key_store!BrowserLocalStorageKeyStore}.
 * @see [https://docs.near.org/docs/develop/front-end/naj-quick-reference#account](https://docs.near.org/tools/near-api-js/quick-reference#account)
 * @see [Account Spec](https://nomicon.io/DataStructures/Account.html)
 */
export class Account extends TransactionSender {
    readonly connection: Connection;
    readonly accountId: string;

    constructor(connection: Connection, accountId: string) {
        super(connection, accountId);
        this.connection = connection;
        this.accountId = accountId;
    }

    /**
     * Returns basic NEAR account information via the `view_account` RPC query method
     * @see [https://docs.near.org/api/rpc/contracts#view-account](https://docs.near.org/api/rpc/contracts#view-account)
     */
    async state(): Promise<AccountView> {
        return this.connection.provider.query<AccountView>({
            request_type: 'view_account',
            account_id: this.accountId,
            finality: 'optimistic'
        });
    }

    /**
     * Create a new account and deploy a contract to it
     *
     * @param contractId NEAR account where the contract is deployed
     * @param publicKey The public key to add to the created contract account
     * @param data The compiled contract code
     * @param amount of NEAR to transfer to the created contract account. Transfer enough to pay for storage https://docs.near.org/docs/concepts/storage-staking
     */
    async createAndDeployContract(contractId: string, publicKey: string | PublicKey, data: Uint8Array, amount: BN): Promise<Account> {
        const accessKey = fullAccessKey();
        await this.signAndSendTransaction({
            receiverId: contractId,
            actions: [createAccount(), transfer(amount), addKey(PublicKey.from(publicKey), accessKey), deployContract(data)]
        });
        const contractAccount = new Account(this.connection, contractId);
        return contractAccount;
    }

    /**
     * @param receiverId NEAR account receiving Ⓝ
     * @param amount Amount to send in yoctoⓃ
     */
    async sendMoney(receiverId: string, amount: BN): Promise<FinalExecutionOutcome> {
        return this.signAndSendTransaction({
            receiverId,
            actions: [transfer(amount)]
        });
    }

    /**
     * @param newAccountId NEAR account name to be created
     * @param publicKey A public key created from the masterAccount
     */
    async createAccount(newAccountId: string, publicKey: string | PublicKey, amount: BN): Promise<FinalExecutionOutcome> {
        const accessKey = fullAccessKey();
        return this.signAndSendTransaction({
            receiverId: newAccountId,
            actions: [createAccount(), transfer(amount), addKey(PublicKey.from(publicKey), accessKey)]
        });
    }

    /**
     * @param beneficiaryId The NEAR account that will receive the remaining Ⓝ balance from the account being deleted
     */
    async deleteAccount(beneficiaryId: string) {
        if (!process.env['NEAR_NO_LOGS']) {
            console.log('Deleting an account does not automatically transfer NFTs and FTs to the beneficiary address. Ensure to transfer assets before deleting.');
        }
        return this.signAndSendTransaction({
            receiverId: this.accountId,
            actions: [deleteAccount(beneficiaryId)]
        });
    }

    /**
     * @param data The compiled contract code
     */
    async deployContract(data: Uint8Array): Promise<FinalExecutionOutcome> {
        return this.signAndSendTransaction({
            receiverId: this.accountId,
            actions: [deployContract(data)]
        });
    }

    /** @hidden */
    private encodeJSContractArgs(contractId: string, method: string, args) {
        return Buffer.concat([Buffer.from(contractId), Buffer.from([0]), Buffer.from(method), Buffer.from([0]), Buffer.from(args)]);
    }

    /**
     * Execute function call
     * @returns {Promise<FinalExecutionOutcome>}
     */
    async functionCall({ contractId, methodName, args = {}, gas = DEFAULT_FUNCTION_CALL_GAS, attachedDeposit, walletMeta, walletCallbackUrl, stringify, jsContract }: ChangeFunctionCallOptions): Promise<FinalExecutionOutcome> {
        this.validateArgs(args);
        let functionCallArgs;

        if(jsContract){
            const encodedArgs = this.encodeJSContractArgs( contractId, methodName, JSON.stringify(args) );
            functionCallArgs =  ['call_js_contract', encodedArgs, gas, attachedDeposit, null, true ];
        } else{
            const stringifyArg = stringify === undefined ? stringifyJsonOrBytes : stringify;
            functionCallArgs = [methodName, args, gas, attachedDeposit, stringifyArg, false];
        }

        return this.signAndSendTransaction({
            receiverId: jsContract ? this.connection.jsvmAccountId: contractId,
            // eslint-disable-next-line prefer-spread
            actions: [functionCall.apply(void 0, functionCallArgs)],
            walletMeta,
            walletCallbackUrl
        });
    }

    /**
     * @see [https://docs.near.org/concepts/basics/accounts/access-keys](https://docs.near.org/concepts/basics/accounts/access-keys)
     * @todo expand this API to support more options.
     * @param publicKey A public key to be associated with the contract
     * @param contractId NEAR account where the contract is deployed
     * @param methodNames The method names on the contract that should be allowed to be called. Pass null for no method names and '' or [] for any method names.
     * @param amount Payment in yoctoⓃ that is sent to the contract during this function call
     */
    async addKey(publicKey: string | PublicKey, contractId?: string, methodNames?: string | string[], amount?: BN): Promise<FinalExecutionOutcome> {
        if (!methodNames) {
            methodNames = [];
        }
        if (!Array.isArray(methodNames)) {
            methodNames = [methodNames];
        }
        let accessKey;
        if (!contractId) {
            accessKey = fullAccessKey();
        } else {
            accessKey = functionCallAccessKey(contractId, methodNames, amount);
        }
        return this.signAndSendTransaction({
            receiverId: this.accountId,
            actions: [addKey(PublicKey.from(publicKey), accessKey)]
        });
    }

    /**
     * @param publicKey The public key to be deleted
     * @returns {Promise<FinalExecutionOutcome>}
     */
    async deleteKey(publicKey: string | PublicKey): Promise<FinalExecutionOutcome> {
        return this.signAndSendTransaction({
            receiverId: this.accountId,
            actions: [deleteKey(PublicKey.from(publicKey))]
        });
    }

    /**
     * @see [https://near-nodes.io/validator/staking-and-delegation](https://near-nodes.io/validator/staking-and-delegation)
     *
     * @param publicKey The public key for the account that's staking
     * @param amount The account to stake in yoctoⓃ
     */
    async stake(publicKey: string | PublicKey, amount: BN): Promise<FinalExecutionOutcome> {
        return this.signAndSendTransaction({
            receiverId: this.accountId,
            actions: [stake(amount, PublicKey.from(publicKey))]
        });
    }

    /** @hidden */
    private validateArgs(args: any) {
        const isUint8Array = args.byteLength !== undefined && args.byteLength === args.length;
        if (isUint8Array) {
            return;
        }

        if (Array.isArray(args) || typeof args !== 'object') {
            throw new PositionalArgsError();
        }
    }

    /**
     * Invoke a contract view function using the RPC API.
     * @see [https://docs.near.org/api/rpc/contracts#call-a-contract-function](https://docs.near.org/api/rpc/contracts#call-a-contract-function)
     *
     * @param viewFunctionCallOptions.contractId NEAR account where the contract is deployed
     * @param viewFunctionCallOptions.methodName The view-only method (no state mutations) name on the contract as it is written in the contract code
     * @param viewFunctionCallOptions.args Any arguments to the view contract method, wrapped in JSON
     * @param viewFunctionCallOptions.parse Parse the result of the call. Receives a Buffer (bytes array) and converts it to any object. By default result will be treated as json.
     * @param viewFunctionCallOptions.stringify Convert input arguments into a bytes array. By default the input is treated as a JSON.
     * @param viewFunctionCallOptions.jsContract Is contract from JS SDK, automatically encodes args from JS SDK to binary.
     * @param viewFunctionCallOptions.blockQuery specifies which block to query state at. By default returns last "optimistic" block (i.e. not necessarily finalized).
     * @returns {Promise<any>}
     */

    async viewFunction({
        contractId,
        methodName,
        args = {},
        parse = parseJsonFromRawResponse,
        stringify = bytesJsonStringify,
        jsContract = false,
        blockQuery = { finality: 'optimistic' }
    }: ViewFunctionCallOptions): Promise<any> {
        let encodedArgs;
        
        this.validateArgs(args);
    
        if(jsContract){
            encodedArgs = this.encodeJSContractArgs(contractId, methodName, Object.keys(args).length >  0 ? JSON.stringify(args): '');
        } else{
            encodedArgs =  stringify(args);
        }

        const result = await this.connection.provider.query<CodeResult>({
            request_type: 'call_function',
            ...blockQuery,
            account_id: jsContract ? this.connection.jsvmAccountId : contractId,
            method_name: jsContract ? 'view_js_contract'  : methodName,
            args_base64: encodedArgs.toString('base64')
        });

        if (result.logs) {
            this.printLogs(contractId, result.logs);
        }

        return result.result && result.result.length > 0 && parse(Buffer.from(result.result));
    }

    /**
     * Returns the state (key value pairs) of this account's contract based on the key prefix.
     * Pass an empty string for prefix if you would like to return the entire state.
     * @see [https://docs.near.org/api/rpc/contracts#view-contract-state](https://docs.near.org/api/rpc/contracts#view-contract-state)
     *
     * @param prefix allows to filter which keys should be returned. Empty prefix means all keys. String prefix is utf-8 encoded.
     * @param blockQuery specifies which block to query state at. By default returns last "optimistic" block (i.e. not necessarily finalized).
     */
    async viewState(prefix: string | Uint8Array, blockQuery: BlockReference = { finality: 'optimistic' } ): Promise<Array<{ key: Buffer; value: Buffer}>> {
        const { values } = await this.connection.provider.query<ViewStateResult>({
            request_type: 'view_state',
            ...blockQuery,
            account_id: this.accountId,
            prefix_base64: Buffer.from(prefix).toString('base64')
        });

        return values.map(({ key, value }) => ({
            key: Buffer.from(key, 'base64'),
            value: Buffer.from(value, 'base64')
        }));
    }

    /**
     * Get all access keys for the account
     * @see [https://docs.near.org/api/rpc/access-keys#view-access-key-list](https://docs.near.org/api/rpc/access-keys#view-access-key-list)
     */
    async getAccessKeys(): Promise<AccessKeyInfoView[]> {
        const response = await this.connection.provider.query<AccessKeyList>({
            request_type: 'view_access_key_list',
            account_id: this.accountId,
            finality: 'optimistic'
        });
        // Replace raw nonce into a new BN
        return response?.keys?.map((key) => ({ ...key, access_key: { ...key.access_key, nonce: new BN(key.access_key.nonce) } }));
    }

    /**
     * Returns a list of authorized apps
     * @todo update the response value to return all the different keys, not just app keys.
     */
    async getAccountDetails(): Promise<{ authorizedApps: AccountAuthorizedApp[] }> {
        // TODO: update the response value to return all the different keys, not just app keys.
        // Also if we need this function, or getAccessKeys is good enough.
        const accessKeys = await this.getAccessKeys();
        const authorizedApps = accessKeys
            .filter(item => item.access_key.permission !== 'FullAccess')
            .map(item => {
                const perm = (item.access_key.permission as FunctionCallPermissionView);
                return {
                    contractId: perm.FunctionCall.receiver_id,
                    amount: perm.FunctionCall.allowance,
                    publicKey: item.public_key,
                };
            });
        return { authorizedApps };
    }

    /**
     * Returns calculated account balance
     */
    async getAccountBalance(): Promise<AccountBalance> {
        const protocolConfig = await this.connection.provider.experimental_protocolConfig({ finality: 'final' });
        const state = await this.state();

        const costPerByte = new BN(protocolConfig.runtime_config.storage_amount_per_byte);
        const stateStaked = new BN(state.storage_usage).mul(costPerByte);
        const staked = new BN(state.locked);
        const totalBalance = new BN(state.amount).add(staked);
        const availableBalance = totalBalance.sub(BN.max(staked, stateStaked));

        return {
            total: totalBalance.toString(),
            stateStaked: stateStaked.toString(),
            staked: staked.toString(),
            available: availableBalance.toString()
        };
    }

    /**
     * Returns the NEAR tokens balance and validators of a given account that is delegated to the staking pools that are part of the validators set in the current epoch.
     * 
     * NOTE: If the tokens are delegated to a staking pool that is currently on pause or does not have enough tokens to participate in validation, they won't be accounted for.
     * @returns {Promise<ActiveDelegatedStakeBalance>}
     */
     async getActiveDelegatedStakeBalance(): Promise<ActiveDelegatedStakeBalance>  {
        const block = await this.connection.provider.block({ finality: 'final' });
        const blockHash = block.header.hash;
        const epochId = block.header.epoch_id;
        const { current_validators, next_validators, current_proposals } = await this.connection.provider.validators(epochId);
        const pools:Set<string> = new Set();
        [...current_validators, ...next_validators, ...current_proposals]
            .forEach((validator) => pools.add(validator.account_id));

        const uniquePools = [...pools];
        const promises = uniquePools
            .map((validator) => (
                this.viewFunction({
                    contractId: validator,
                    methodName: 'get_account_total_balance',
                    args: { account_id: this.accountId },
                    blockQuery: { blockId: blockHash }
                })
            ));

        const results = await Promise.allSettled(promises);

        const hasTimeoutError = results.some((result) => {
            if (result.status === 'rejected' && result.reason.type === 'TimeoutError') {
                return true;
            }
            return false;
        });

        // When RPC is down and return timeout error, throw error
        if (hasTimeoutError) {
            throw new Error('Failed to get delegated stake balance');
        }
        const summary = results.reduce((result, state, index) => {
            const validatorId = uniquePools[index];
            if (state.status === 'fulfilled') {
                const currentBN = new BN(state.value);
                if (!currentBN.isZero()) {
                    return {
                        ...result,
                        stakedValidators: [...result.stakedValidators, { validatorId, amount: currentBN.toString() }],
                        total: result.total.add(currentBN),
                    };
                }
            }
            if (state.status === 'rejected') {
                return {
                    ...result,
                    failedValidators: [...result.failedValidators, { validatorId, error: state.reason }],
                };
            }
            return result;
        },
        { stakedValidators: [], failedValidators: [], total: new BN(0) });

        return {
            ...summary,
            total: summary.total.toString(),
        };
    }

    createTransaction(receiver: Account | string): TransactionBuilder {
        return new TransactionBuilder(this.connection, this.accountId, typeof receiver === 'string' ? receiver : receiver.accountId);
    }
  
    async hasDeployedContract(): Promise<boolean> {
        return (await this.state()).code_hash !== EMPTY_CONTRACT_HASH;
    }
}
