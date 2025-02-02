export * from "./state";
import { Program } from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import {
    Connection,
    PublicKey,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    SystemProgram,
    TransactionInstruction,
} from "@solana/web3.js";
import { Keccak } from "sha3";
import IDL from "../idl/json/token_router.json";
import { TokenRouter } from "../idl/ts/token_router";
import {
    CctpTokenBurnMessage,
    MessageTransmitterProgram,
    TokenMessengerMinterProgram,
} from "../cctp";
import {
    cctpMessageAddress,
    coreMessageAddress,
    reclaimCctpMessageIx,
    uint64ToBN,
} from "../common";
import * as matchingEngineSdk from "../matchingEngine";
import { UpgradeManagerProgram } from "../upgradeManager";
import { BPF_LOADER_UPGRADEABLE_PROGRAM_ID, programDataAddress } from "../utils";
import { VaaAccount } from "../wormhole";
import { Custodian, PreparedFill, PreparedOrder } from "./state";
import { ChainId, isChainId } from "@wormhole-foundation/sdk-base";

export const PROGRAM_IDS = [
    "TokenRouter11111111111111111111111111111111",
    "tD8RmtdcV7bzBeuFgyrFc8wvayj988ChccEzRQzo6md",
] as const;

export type ProgramId = (typeof PROGRAM_IDS)[number];

export type PrepareMarketOrderArgs = {
    amountIn: bigint;
    minAmountOut: bigint | null;
    targetChain: number;
    redeemer: Array<number>;
    redeemerMessage: Buffer;
};

export type PublishMessageAccounts = {
    coreBridgeConfig: PublicKey;
    coreEmitterSequence: PublicKey;
    coreFeeCollector: PublicKey;
    coreBridgeProgram: PublicKey;
};

export type TokenRouterCommonAccounts = PublishMessageAccounts & {
    tokenRouterProgram: PublicKey;
    systemProgram: PublicKey;
    rent: PublicKey;
    clock: PublicKey;
    custodian: PublicKey;
    cctpMintRecipient: PublicKey;
    tokenMessenger: PublicKey;
    tokenMinter: PublicKey;
    tokenMessengerMinterSenderAuthority: PublicKey;
    tokenMessengerMinterProgram: PublicKey;
    messageTransmitterAuthority: PublicKey;
    messageTransmitterConfig: PublicKey;
    messageTransmitterProgram: PublicKey;
    tokenProgram: PublicKey;
    mint: PublicKey;
    localToken: PublicKey;
    tokenMessengerMinterCustodyToken: PublicKey;
    matchingEngineProgram: PublicKey;
    matchingEngineCustodian: PublicKey;
    matchingEngineCctpMintRecipient: PublicKey;
};

export type RedeemFillCctpAccounts = {
    custodian: PublicKey;
    preparedFill: PublicKey;
    cctpMintRecipient: PublicKey;
    routerEndpoint: PublicKey;
    messageTransmitterAuthority: PublicKey;
    messageTransmitterConfig: PublicKey;
    usedNonces: PublicKey;
    messageTransmitterEventAuthority: PublicKey;
    tokenMessenger: PublicKey;
    remoteTokenMessenger: PublicKey;
    tokenMinter: PublicKey;
    localToken: PublicKey;
    tokenPair: PublicKey;
    tokenMessengerMinterCustodyToken: PublicKey;
    tokenMessengerMinterProgram: PublicKey;
    messageTransmitterProgram: PublicKey;
    tokenMessengerMinterEventAuthority: PublicKey;
};

export type RedeemFastFillAccounts = {
    custodian: PublicKey;
    preparedFill: PublicKey;
    cctpMintRecipient: PublicKey;
    matchingEngineCustodian: PublicKey;
    matchingEngineFromEndpoint: PublicKey;
    matchingEngineToEndpoint: PublicKey;
    matchingEngineLocalCustodyToken: PublicKey;
    matchingEngineProgram: PublicKey;
};

export type AddCctpRouterEndpointArgs = {
    chain: number;
    cctpDomain: number;
    address: Array<number>;
    mintRecipient: Array<number> | null;
};

export class TokenRouterProgram {
    private _programId: ProgramId;
    private _mint: PublicKey;

    program: Program<TokenRouter>;

    // TODO: fix this
    constructor(connection: Connection, programId: ProgramId, mint: PublicKey) {
        this._programId = programId;
        this._mint = mint;
        this.program = new Program(
            { ...(IDL as any), address: this._programId },
            {
                connection,
            },
        );
    }

    get ID(): PublicKey {
        return this.program.programId;
    }

    get mint(): PublicKey {
        return this._mint;
    }

    custodianAddress(): PublicKey {
        return Custodian.address(this.ID);
    }

    async fetchCustodian(input?: { address: PublicKey }): Promise<Custodian> {
        const addr = input === undefined ? this.custodianAddress() : input.address;
        return this.program.account.custodian.fetch(addr);
    }

    cctpMintRecipientAddress(): PublicKey {
        return splToken.getAssociatedTokenAddressSync(this.mint, this.custodianAddress(), true);
    }

    preparedCustodyTokenAddress(preparedAccount: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("prepared-custody"), preparedAccount.toBuffer()],
            this.ID,
        )[0];
    }

    coreMessageAddress(preparedOrder: PublicKey): PublicKey {
        return coreMessageAddress(this.ID, preparedOrder);
    }

    cctpMessageAddress(preparedOrder: PublicKey): PublicKey {
        return cctpMessageAddress(this.ID, preparedOrder);
    }

    async reclaimCctpMessageIx(
        accounts: {
            payer: PublicKey;
            cctpMessage: PublicKey;
        },
        cctpAttestation: Buffer,
    ): Promise<TransactionInstruction> {
        return reclaimCctpMessageIx(this.messageTransmitterProgram(), accounts, cctpAttestation);
    }

    async fetchPreparedOrder(addr: PublicKey): Promise<PreparedOrder> {
        return this.program.account.preparedOrder.fetch(addr);
    }

    preparedFillAddress(fillSource: PublicKey) {
        return PreparedFill.address(this.ID, fillSource);
    }

    // TODO: fix
    async fetchPreparedFill(addr: PublicKey): Promise<PreparedFill> {
        return this.program.account.preparedFill.fetch(addr);
    }

    transferAuthorityAddress(preparedOrder: PublicKey, args: PrepareMarketOrderArgs): PublicKey {
        const { amountIn, minAmountOut, targetChain, redeemer, redeemerMessage } = args;
        const hasher = new Keccak(256);
        hasher.update(uint64ToBN(amountIn).toBuffer("be", 8));
        if (minAmountOut !== null) {
            hasher.update(uint64ToBN(minAmountOut).toBuffer("be", 8));
        }
        hasher.update(
            (() => {
                const buf = Buffer.alloc(2);
                buf.writeUInt16BE(targetChain);
                return buf;
            })(),
        );
        hasher.update(Buffer.from(redeemer));
        hasher.update(redeemerMessage);

        return PublicKey.findProgramAddressSync(
            [Buffer.from("transfer-authority"), preparedOrder.toBuffer(), hasher.digest()],
            this.ID,
        )[0];
    }

    async commonAccounts(): Promise<TokenRouterCommonAccounts> {
        const custodian = this.custodianAddress();
        const { coreBridgeConfig, coreEmitterSequence, coreFeeCollector, coreBridgeProgram } =
            this.publishMessageAccounts(custodian);

        const tokenMessengerMinterProgram = this.tokenMessengerMinterProgram();
        const messageTransmitterProgram = this.messageTransmitterProgram();

        const cctpMintRecipient = this.cctpMintRecipientAddress();
        const mint = this.mint;

        const matchingEngine = this.matchingEngineProgram();

        return {
            tokenRouterProgram: this.ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            clock: SYSVAR_CLOCK_PUBKEY,
            custodian,
            cctpMintRecipient,
            coreBridgeConfig,
            coreEmitterSequence,
            coreFeeCollector,
            coreBridgeProgram,
            tokenMessenger: tokenMessengerMinterProgram.tokenMessengerAddress(),
            tokenMinter: tokenMessengerMinterProgram.tokenMinterAddress(),
            tokenMessengerMinterSenderAuthority:
                tokenMessengerMinterProgram.senderAuthorityAddress(),
            tokenMessengerMinterProgram: tokenMessengerMinterProgram.ID,
            messageTransmitterAuthority: messageTransmitterProgram.authorityAddress(
                tokenMessengerMinterProgram.ID,
            ),
            messageTransmitterConfig: messageTransmitterProgram.messageTransmitterConfigAddress(),
            messageTransmitterProgram: messageTransmitterProgram.ID,
            tokenProgram: splToken.TOKEN_PROGRAM_ID,
            mint,
            localToken: tokenMessengerMinterProgram.localTokenAddress(mint),
            tokenMessengerMinterCustodyToken: tokenMessengerMinterProgram.custodyTokenAddress(mint),
            matchingEngineProgram: matchingEngine.ID,
            matchingEngineCustodian: matchingEngine.custodianAddress(),
            matchingEngineCctpMintRecipient: matchingEngine.cctpMintRecipientAddress(),
        };
    }

    checkedCustodianComposite(addr?: PublicKey): { custodian: PublicKey } {
        return { custodian: addr ?? this.custodianAddress() };
    }

    adminComposite(
        ownerOrAssistant: PublicKey,
        custodian?: PublicKey,
    ): { ownerOrAssistant: PublicKey; custodian: { custodian: PublicKey } } {
        return { ownerOrAssistant, custodian: this.checkedCustodianComposite(custodian) };
    }

    adminMutComposite(
        ownerOrAssistant: PublicKey,
        custodian?: PublicKey,
    ): { ownerOrAssistant: PublicKey; custodian: PublicKey } {
        return { ownerOrAssistant, custodian: custodian ?? this.custodianAddress() };
    }

    ownerOnlyComposite(
        owner: PublicKey,
        custodian?: PublicKey,
    ): { owner: PublicKey; custodian: { custodian: PublicKey } } {
        return { owner, custodian: this.checkedCustodianComposite(custodian) };
    }

    ownerOnlyMutComposite(
        owner: PublicKey,
        custodian?: PublicKey,
    ): { owner: PublicKey; custodian: PublicKey } {
        return { owner, custodian: custodian ?? this.custodianAddress() };
    }

    liquidityLayerVaaComposite(vaa: PublicKey): { vaa: PublicKey } {
        return {
            vaa,
        };
    }

    usdcComposite(mint?: PublicKey): { mint: PublicKey } {
        return {
            mint: mint ?? this.mint,
        };
    }

    initIfNeededPreparedFillComposite(accounts: {
        payer: PublicKey;
        vaa: PublicKey;
        preparedFill: PublicKey;
    }) {
        const { payer, vaa, preparedFill } = accounts;
        return {
            payer,
            fillVaa: this.liquidityLayerVaaComposite(vaa),
            preparedFill,
            custodyToken: this.preparedCustodyTokenAddress(preparedFill),
            usdc: this.usdcComposite(),
            tokenProgram: splToken.TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        };
    }

    async approveTransferAuthorityIx(
        accounts: {
            preparedOrder: PublicKey;
            senderToken: PublicKey;
            senderTokenAuthority?: PublicKey;
        },
        args: PrepareMarketOrderArgs,
    ): Promise<{ transferAuthority: PublicKey; ix: TransactionInstruction }> {
        const { preparedOrder, senderToken } = accounts;
        const { amountIn } = args;

        let { senderTokenAuthority } = accounts;
        senderTokenAuthority ??= await (async () => {
            const tokenAccount = await splToken.getAccount(
                this.program.provider.connection,
                senderToken,
            );
            return tokenAccount.owner;
        })();

        const transferAuthority = this.transferAuthorityAddress(preparedOrder, args);

        return {
            transferAuthority,
            ix: splToken.createApproveInstruction(
                senderToken,
                transferAuthority,
                senderTokenAuthority,
                amountIn,
            ),
        };
    }

    async prepareMarketOrderIx(
        accounts: {
            payer: PublicKey;
            preparedOrder: PublicKey;
            senderToken: PublicKey;
            senderTokenAuthority?: PublicKey;
            refundToken?: PublicKey;
            programTransferAuthority?: PublicKey | null;
            sender?: PublicKey | null;
        },
        args: { useTransferAuthority?: boolean } & PrepareMarketOrderArgs,
    ): Promise<[approveIx: TransactionInstruction | null, prepareIx: TransactionInstruction]> {
        const { payer, preparedOrder, senderToken, senderTokenAuthority } = accounts;

        let { refundToken, programTransferAuthority, sender } = accounts;
        refundToken ??= senderToken;

        let { useTransferAuthority } = args;
        useTransferAuthority ??= true;

        let approveIx: TransactionInstruction | null = null;

        if (sender === undefined) {
            sender = null;
        }

        if (programTransferAuthority === undefined) {
            if (useTransferAuthority) {
                const approveResult = await this.approveTransferAuthorityIx(
                    { preparedOrder, senderToken, senderTokenAuthority },
                    args,
                );
                programTransferAuthority = approveResult.transferAuthority;
                approveIx = approveResult.ix;
            } else {
                programTransferAuthority = null;
            }
        }

        const prepareIx = await this.program.methods
            .prepareMarketOrder({
                ...args,
                amountIn: uint64ToBN(args.amountIn),
                minAmountOut: args.minAmountOut === null ? null : uint64ToBN(args.minAmountOut),
            })
            .accounts({
                payer,
                custodian: this.checkedCustodianComposite(),
                programTransferAuthority,
                // @ts-ignore Sender can be null.
                sender,
                preparedOrder,
                senderToken,
                refundToken,
                preparedCustodyToken: this.preparedCustodyTokenAddress(preparedOrder),
                usdc: this.usdcComposite(),
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .instruction();

        return [approveIx, prepareIx];
    }

    async closePreparedOrderIx(accounts: {
        preparedOrder: PublicKey;
        preparedBy?: PublicKey;
        orderSender?: PublicKey;
        refundToken?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { preparedOrder } = accounts;
        let { preparedBy, orderSender, refundToken } = accounts;

        if (preparedBy === undefined || orderSender === undefined || refundToken === undefined) {
            const { info } = await this.fetchPreparedOrder(preparedOrder);

            preparedBy ??= info.preparedBy;
            orderSender ??= info.orderSender;
            refundToken ??= info.refundToken;
        }

        return this.program.methods
            .closePreparedOrder()
            .accounts({
                preparedBy,
                custodian: this.checkedCustodianComposite(),
                orderSender,
                preparedOrder,
                refundToken,
                preparedCustodyToken: this.preparedCustodyTokenAddress(preparedOrder),
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
            })
            .instruction();
    }

    async consumePreparedFillIx(accounts: {
        preparedFill: PublicKey;
        redeemer: PublicKey;
        dstToken: PublicKey;
        beneficiary: PublicKey;
    }): Promise<TransactionInstruction> {
        const { preparedFill, redeemer, dstToken, beneficiary } = accounts;

        return this.program.methods
            .consumePreparedFill()
            .accounts({
                redeemer,
                beneficiary,
                preparedFill,
                dstToken,
                preparedCustodyToken: this.preparedCustodyTokenAddress(preparedFill),
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
            })
            .instruction();
    }

    async placeMarketOrderCctpIx(
        accounts: {
            payer: PublicKey;
            preparedOrder: PublicKey;
            preparedBy?: PublicKey;
            routerEndpoint?: PublicKey;
        },
        args: {
            targetChain?: ChainId;
            destinationDomain?: number;
        } = {},
    ): Promise<TransactionInstruction> {
        const { payer, preparedOrder } = accounts;
        let { preparedBy, routerEndpoint } = accounts;
        let { targetChain, destinationDomain } = args;

        if (preparedBy === undefined || targetChain === undefined) {
            const { info } = await this.fetchPreparedOrder(preparedOrder).catch((_) => {
                throw new Error("Cannot find prepared order");
            });

            preparedBy ??= info.preparedBy;

            if (!isChainId(info.targetChain)) {
                throw new Error("Invalid chain found in prepared order");
            }
            targetChain ??= info.targetChain;
        }

        const matchingEngine = this.matchingEngineProgram();
        routerEndpoint ??= matchingEngine.routerEndpointAddress(targetChain);

        const coreMessage = this.coreMessageAddress(preparedOrder);
        const cctpMessage = this.cctpMessageAddress(preparedOrder);

        if (destinationDomain === undefined) {
            const { protocol } = await matchingEngine.fetchRouterEndpointInfo({
                address: routerEndpoint,
            });
            if (protocol.cctp === undefined) {
                throw new Error("invalid router endpoint");
            }
            destinationDomain = protocol.cctp.domain;
        }

        const {
            senderAuthority: tokenMessengerMinterSenderAuthority,
            messageTransmitterConfig,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenMessengerMinterEventAuthority,
            messageTransmitterProgram,
            tokenMessengerMinterProgram,
        } = this.tokenMessengerMinterProgram().depositForBurnWithCallerAccounts(
            this.mint,
            destinationDomain,
        );

        const custodian = this.custodianAddress();
        const { coreBridgeConfig, coreEmitterSequence, coreFeeCollector, coreBridgeProgram } =
            this.publishMessageAccounts(custodian);

        return this.program.methods
            .placeMarketOrderCctp()
            .accounts({
                payer,
                preparedBy,
                custodian: this.checkedCustodianComposite(),
                preparedOrder,
                mint: this.mint,
                preparedCustodyToken: this.preparedCustodyTokenAddress(preparedOrder),
                routerEndpoint,
                coreBridgeConfig,
                coreMessage,
                cctpMessage,
                coreEmitterSequence,
                coreFeeCollector,
                tokenMessengerMinterSenderAuthority,
                messageTransmitterConfig,
                tokenMessenger,
                remoteTokenMessenger,
                tokenMinter,
                localToken,
                tokenMessengerMinterEventAuthority,
                coreBridgeProgram,
                tokenMessengerMinterProgram,
                messageTransmitterProgram,
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                clock: SYSVAR_CLOCK_PUBKEY,
            })
            .instruction();
    }

    async redeemCctpFillAccounts(
        fillVaa: PublicKey,
        cctpMessage: CctpTokenBurnMessage | Buffer,
    ): Promise<RedeemFillCctpAccounts> {
        const msg = CctpTokenBurnMessage.from(cctpMessage);
        const cctpMintRecipient = this.cctpMintRecipientAddress();

        const vaaAccount = await VaaAccount.fetch(this.program.provider.connection, fillVaa);
        const { chain } = vaaAccount.emitterInfo();
        const preparedFill = this.preparedFillAddress(fillVaa);

        const {
            authority: messageTransmitterAuthority,
            messageTransmitterConfig,
            usedNonces,
            messageTransmitterEventAuthority,
            tokenMessengerMinterProgram,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenPair,
            custodyToken: tokenMessengerMinterCustodyToken,
            tokenMessengerMinterEventAuthority,
            messageTransmitterProgram,
        } = this.messageTransmitterProgram().receiveTokenMessengerMinterMessageAccounts(
            this.mint,
            msg,
        );

        return {
            custodian: this.custodianAddress(),
            preparedFill,
            cctpMintRecipient,
            routerEndpoint: this.matchingEngineProgram().routerEndpointAddress(chain),
            messageTransmitterAuthority,
            messageTransmitterConfig,
            usedNonces,
            messageTransmitterEventAuthority,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenPair,
            tokenMessengerMinterCustodyToken,
            tokenMessengerMinterProgram,
            messageTransmitterProgram,
            tokenMessengerMinterEventAuthority,
        };
    }

    async redeemCctpFillIx(
        accounts: {
            payer: PublicKey;
            vaa: PublicKey;
            routerEndpoint?: PublicKey;
        },
        args: {
            encodedCctpMessage: Buffer;
            cctpAttestation: Buffer;
        },
    ): Promise<TransactionInstruction> {
        const { payer, vaa } = accounts;
        const { encodedCctpMessage } = args;

        let { routerEndpoint } = accounts;

        const {
            preparedFill,
            cctpMintRecipient,
            routerEndpoint: derivedRouterEndpoint,
            messageTransmitterAuthority,
            messageTransmitterConfig,
            usedNonces,
            messageTransmitterEventAuthority,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenPair,
            tokenMessengerMinterCustodyToken,
            tokenMessengerMinterProgram,
            messageTransmitterProgram,
            tokenMessengerMinterEventAuthority,
        } = await this.redeemCctpFillAccounts(vaa, encodedCctpMessage);
        routerEndpoint ??= derivedRouterEndpoint;

        return this.program.methods
            .redeemCctpFill(args)
            .accounts({
                payer,
                custodian: this.checkedCustodianComposite(),
                fillVaa: this.liquidityLayerVaaComposite(vaa),
                preparedFill,
                preparedCustodyToken: this.preparedCustodyTokenAddress(preparedFill),
                usdc: this.usdcComposite(),
                routerEndpoint,
                cctp: {
                    mintRecipient: { mintRecipient: cctpMintRecipient },
                    messageTransmitterAuthority,
                    messageTransmitterConfig,
                    usedNonces,
                    messageTransmitterEventAuthority,
                    tokenMessenger,
                    remoteTokenMessenger,
                    tokenMinter,
                    localToken,
                    tokenPair,
                    tokenMessengerMinterCustodyToken,
                    tokenMessengerMinterEventAuthority,
                    tokenMessengerMinterProgram,
                    messageTransmitterProgram,
                },
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .instruction();
    }

    async redeemFastFillAccounts(fastFill: PublicKey): Promise<RedeemFastFillAccounts> {
        const {
            custodian: matchingEngineCustodian,
            fromRouterEndpoint: matchingEngineFromEndpoint,
            toRouterEndpoint: matchingEngineToEndpoint,
            localCustodyToken: matchingEngineLocalCustodyToken,
            matchingEngineProgram,
        } = await this.matchingEngineProgram().redeemFastFillAccounts(fastFill);

        return {
            custodian: this.custodianAddress(),
            preparedFill: this.preparedFillAddress(fastFill),
            cctpMintRecipient: this.cctpMintRecipientAddress(),
            matchingEngineCustodian,
            matchingEngineFromEndpoint,
            matchingEngineToEndpoint,
            matchingEngineLocalCustodyToken,
            matchingEngineProgram,
        };
    }
    async redeemFastFillIx(accounts: {
        payer: PublicKey;
        fastFill: PublicKey;
    }): Promise<TransactionInstruction> {
        const { payer, fastFill } = accounts;
        const {
            preparedFill,
            matchingEngineCustodian,
            matchingEngineFromEndpoint,
            matchingEngineToEndpoint,
            matchingEngineLocalCustodyToken,
            matchingEngineProgram,
        } = await this.redeemFastFillAccounts(fastFill);

        return this.program.methods
            .redeemFastFill()
            .accounts({
                payer,
                custodian: this.checkedCustodianComposite(),
                fastFill,
                preparedFill,
                preparedCustodyToken: this.preparedCustodyTokenAddress(preparedFill),
                usdc: this.usdcComposite(),
                matchingEngineCustodian,
                matchingEngineFromEndpoint,
                matchingEngineToEndpoint,
                matchingEngineLocalCustodyToken,
                matchingEngineProgram,
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .instruction();
    }

    async initializeIx(accounts: {
        owner: PublicKey;
        ownerAssistant: PublicKey;
        mint?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { owner, ownerAssistant, mint: inputMint } = accounts;

        const upgradeManager = this.upgradeManagerProgram();
        return this.program.methods
            .initialize()
            .accounts({
                owner,
                custodian: this.custodianAddress(),
                ownerAssistant,
                mint: this.usdcComposite(inputMint),
                cctpMintRecipient: this.cctpMintRecipientAddress(),
                programData: programDataAddress(this.ID),
                upgradeManagerAuthority: upgradeManager.upgradeAuthorityAddress(),
                upgradeManagerProgram: upgradeManager.ID,
                bpfLoaderUpgradeableProgram: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
                associatedTokenProgram: splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .instruction();
    }

    async setPauseIx(
        accounts: {
            ownerOrAssistant: PublicKey;
            custodian?: PublicKey;
        },
        paused: boolean,
    ): Promise<TransactionInstruction> {
        const { ownerOrAssistant, custodian: inputCustodian } = accounts;
        return this.program.methods
            .setPause(paused)
            .accounts({
                admin: this.adminMutComposite(ownerOrAssistant, inputCustodian),
            })
            .instruction();
    }

    async submitOwnershipTransferIx(accounts: {
        owner: PublicKey;
        newOwner: PublicKey;
        custodian?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { owner, newOwner, custodian: inputCustodian } = accounts;
        return this.program.methods
            .submitOwnershipTransferRequest()
            .accounts({
                admin: this.ownerOnlyMutComposite(owner, inputCustodian),
                newOwner,
            })
            .instruction();
    }

    async confirmOwnershipTransferIx(accounts: {
        pendingOwner: PublicKey;
        custodian?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { pendingOwner, custodian: inputCustodian } = accounts;
        return this.program.methods
            .confirmOwnershipTransferRequest()
            .accounts({
                pendingOwner,
                custodian: inputCustodian ?? this.custodianAddress(),
            })
            .instruction();
    }

    async cancelOwnershipTransferIx(accounts: {
        owner: PublicKey;
        custodian?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { owner, custodian: inputCustodian } = accounts;
        return this.program.methods
            .cancelOwnershipTransferRequest()
            .accounts({
                admin: this.ownerOnlyMutComposite(owner, inputCustodian),
            })
            .instruction();
    }

    async updateOwnerAssistantIx(accounts: {
        owner: PublicKey;
        newOwnerAssistant: PublicKey;
        custodian?: PublicKey;
    }) {
        const { owner, newOwnerAssistant, custodian: inputCustodian } = accounts;
        return this.program.methods
            .updateOwnerAssistant()
            .accounts({
                admin: this.ownerOnlyMutComposite(owner, inputCustodian),
                newOwnerAssistant,
            })
            .instruction();
    }

    publishMessageAccounts(emitter: PublicKey): PublishMessageAccounts {
        const coreBridgeProgram = this.coreBridgeProgramId();

        return {
            coreBridgeConfig: PublicKey.findProgramAddressSync(
                [Buffer.from("Bridge")],
                coreBridgeProgram,
            )[0],
            coreEmitterSequence: PublicKey.findProgramAddressSync(
                [Buffer.from("Sequence"), emitter.toBuffer()],
                coreBridgeProgram,
            )[0],
            coreFeeCollector: PublicKey.findProgramAddressSync(
                [Buffer.from("fee_collector")],
                coreBridgeProgram,
            )[0],
            coreBridgeProgram,
        };
    }

    upgradeManagerProgram(): UpgradeManagerProgram {
        switch (this._programId) {
            case testnet(): {
                return new UpgradeManagerProgram(
                    this.program.provider.connection,
                    "ucdP9ktgrXgEUnn6roqD2SfdGMR2JSiWHUKv23oXwxt",
                );
            }
            case localnet(): {
                return new UpgradeManagerProgram(
                    this.program.provider.connection,
                    "UpgradeManager11111111111111111111111111111",
                );
            }
            default: {
                throw new Error("unsupported network");
            }
        }
    }

    tokenMessengerMinterProgram(): TokenMessengerMinterProgram {
        return new TokenMessengerMinterProgram(
            this.program.provider.connection,
            "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
        );
    }

    messageTransmitterProgram(): MessageTransmitterProgram {
        return new MessageTransmitterProgram(
            this.program.provider.connection,
            "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
        );
    }

    matchingEngineProgram(): matchingEngineSdk.MatchingEngineProgram {
        switch (this._programId) {
            case testnet(): {
                return new matchingEngineSdk.MatchingEngineProgram(
                    this.program.provider.connection,
                    matchingEngineSdk.testnet(),
                    this.mint,
                );
            }
            case localnet(): {
                return new matchingEngineSdk.MatchingEngineProgram(
                    this.program.provider.connection,
                    matchingEngineSdk.localnet(),
                    this.mint,
                );
            }
            default: {
                throw new Error("unsupported network");
            }
        }
    }

    coreBridgeProgramId(): PublicKey {
        switch (this._programId) {
            case testnet(): {
                return new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
            }
            case localnet(): {
                return new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");
            }
            default: {
                throw new Error("unsupported network");
            }
        }
    }
}

export function localnet(): ProgramId {
    return "TokenRouter11111111111111111111111111111111";
}

export function testnet(): ProgramId {
    return "tD8RmtdcV7bzBeuFgyrFc8wvayj988ChccEzRQzo6md";
}
