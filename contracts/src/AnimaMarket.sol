// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AnimaMarket
/// @notice Native-0G fixed-price escrow for anima agent jobs.
/// @dev String-thesis pattern (project-anima §29): no evaluator, no off-chain
/// relayer, no EIP-712/EIP-3009 ceremony. Each agent's local harness signs
/// with its own EOA and is the msg.sender. Negotiation happens off-chain via
/// the A2A messaging layer (AnimaInbox). This contract is the settlement
/// layer only.
///
/// State machine:
///   Funded -> Done -> (Accepted | Disputed) -> Settled
///
/// Disputes resolve via co-signed splits (proposeSplit pattern) or auto-
/// refund to buyer at MAX_JOB_LIFETIME. No judge, no arbitrator in MVP. The
/// asymmetric default-to-buyer is intentional: providers bear dispute risk,
/// reputation gates future job flow.
///
/// Reentrancy: every external function is nonReentrant, and every settle
/// path follows checks-effects-interactions: status flips to Settled BEFORE
/// any native value transfer, so re-entry sees Settled and reverts with
/// InvalidStatus before reaching another transfer.
///
/// Custody: contract holds escrowed 0G between createJob and settle. No
/// owner, no upgrade path, no admin functions. The feeRecipient is set
/// once at deploy and is immutable.
contract AnimaMarket is ReentrancyGuard {
    enum JobStatus {
        Funded,    // 0 — escrow active, provider working
        Done,      // 1 — provider marked done, 24h timer running
        Disputed,  // 2 — buyer disputed during Done window, funds locked
        Settled    // 3 — terminal: funds released
    }

    struct Job {
        address buyer;
        address provider;
        uint256 amount;
        bytes32 descriptionHash;
        JobStatus status;
        uint256 createdAt;
        uint256 doneAt;
    }

    // ── Constants ──

    /// @notice 5% protocol fee, taken at every settle (non-forceClose) path.
    uint256 public constant PROTOCOL_FEE_BPS = 500;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Window after markDone during which buyer may accept or dispute.
    /// After this window expires, anyone may claimTimeout to settle to provider.
    uint256 public constant ACCEPTANCE_PERIOD = 24 hours;

    /// @notice Hard cap on total job lifetime. After this, anyone may force-
    /// close with full refund to buyer (no fee). Safety valve for stalled
    /// disputes or unresponsive providers.
    uint256 public constant MAX_JOB_LIFETIME = 7 days;

    /// @notice Dust floor on createJob. Below this, fee math rounds to zero
    /// and the job is economically meaningless. 0.001 0G ≈ $0.0006.
    uint256 public constant MIN_JOB_AMOUNT = 1e15;

    // ── Storage ──

    /// @notice Recipient of the 5% protocol fee. Set once at deploy. Cannot
    /// be changed; redirecting fees requires deploying a sibling contract.
    address public immutable feeRecipient;

    /// @notice Monotonically increasing job counter. Job ids start at 0.
    uint256 public jobCount;

    mapping(uint256 => Job) internal _jobs;

    /// @notice Co-signed dispute resolution: jobId → party → keccak256(buyer, provider).
    /// When both parties' hashes match for the same jobId, the contract
    /// settles automatically. Last write per party wins; either party may
    /// re-propose by calling proposeSplit again with new amounts.
    mapping(uint256 => mapping(address => bytes32)) public splitProposals;

    // ── Events ──

    event JobCreated(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed provider,
        uint256 amount,
        bytes32 descriptionHash
    );
    event JobMarkedDone(uint256 indexed jobId, uint256 doneAt);
    event JobAccepted(uint256 indexed jobId);
    event JobDisputed(uint256 indexed jobId);
    event JobSettled(uint256 indexed jobId, address indexed recipient, uint256 payout, uint256 fee);
    event SplitProposed(
        uint256 indexed jobId,
        address indexed proposer,
        uint256 buyerAmount,
        uint256 providerAmount
    );
    event SplitResolved(
        uint256 indexed jobId,
        uint256 buyerPayout,
        uint256 providerPayout,
        uint256 fee
    );
    event JobForceClosed(uint256 indexed jobId);

    // ── Errors ──

    error ZeroAddress();
    error SelfTrade();
    error AmountBelowMinimum();
    error JobNotFound(uint256 jobId);
    error InvalidStatus(uint256 jobId, JobStatus expected, JobStatus actual);
    error NotBuyer();
    error NotProvider();
    error NotParty();
    error AcceptancePeriodNotExpired(uint256 jobId);
    error AcceptancePeriodExpired(uint256 jobId);
    error MaxLifetimeNotExpired(uint256 jobId);
    error AlreadySettled(uint256 jobId);
    error InvalidSplitAmounts(uint256 total, uint256 expected);
    error NativeTransferFailed(address to, uint256 amount);

    constructor(address feeRecipient_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
    }

    // ── Lifecycle ──

    /// @notice Buyer creates and funds a job in one tx via msg.value.
    /// @param provider Counterparty doing the work. Must be non-zero and not msg.sender.
    /// @param descriptionHash Off-chain commit hash of the job description.
    /// Empty hash (bytes32(0)) is allowed when the agreement is purely A2A.
    /// @return jobId Auto-incremented job id.
    function createJob(address provider, bytes32 descriptionHash)
        external
        payable
        nonReentrant
        returns (uint256 jobId)
    {
        if (provider == address(0)) revert ZeroAddress();
        if (provider == msg.sender) revert SelfTrade();
        if (msg.value < MIN_JOB_AMOUNT) revert AmountBelowMinimum();

        jobId = jobCount++;
        _jobs[jobId] = Job({
            buyer: msg.sender,
            provider: provider,
            amount: msg.value,
            descriptionHash: descriptionHash,
            status: JobStatus.Funded,
            createdAt: block.timestamp,
            doneAt: 0
        });

        emit JobCreated(jobId, msg.sender, provider, msg.value, descriptionHash);
    }

    /// @notice Provider signals the work is complete. Starts ACCEPTANCE_PERIOD.
    function markDone(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != JobStatus.Funded) {
            revert InvalidStatus(jobId, JobStatus.Funded, job.status);
        }

        job.status = JobStatus.Done;
        job.doneAt = block.timestamp;

        emit JobMarkedDone(jobId, block.timestamp);
    }

    /// @notice Buyer accepts the result. Releases payout to provider minus fee.
    function acceptResult(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.buyer) revert NotBuyer();
        if (job.status != JobStatus.Done) {
            revert InvalidStatus(jobId, JobStatus.Done, job.status);
        }

        emit JobAccepted(jobId);
        _settle(job, jobId, job.provider);
    }

    /// @notice Buyer disputes during the ACCEPTANCE_PERIOD. Funds lock until
    /// proposeSplit co-signs OR forceClose hits at MAX_JOB_LIFETIME.
    function dispute(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.buyer) revert NotBuyer();
        if (job.status != JobStatus.Done) {
            revert InvalidStatus(jobId, JobStatus.Done, job.status);
        }
        if (block.timestamp >= job.doneAt + ACCEPTANCE_PERIOD) {
            revert AcceptancePeriodExpired(jobId);
        }

        job.status = JobStatus.Disputed;
        emit JobDisputed(jobId);
    }

    /// @notice After the silent ACCEPTANCE_PERIOD, anyone may release funds
    /// to the provider. Public callable for permissionless settlement; the
    /// caller does not receive any of the funds.
    function claimTimeout(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Done) {
            revert InvalidStatus(jobId, JobStatus.Done, job.status);
        }
        if (block.timestamp < job.doneAt + ACCEPTANCE_PERIOD) {
            revert AcceptancePeriodNotExpired(jobId);
        }

        _settle(job, jobId, job.provider);
    }

    /// @notice Either disputing party proposes a split. When the other
    /// party posts a matching hash, the contract settles automatically.
    /// @dev `buyerAmount + providerAmount` must equal `job.amount`. The
    /// 5% protocol fee is taken from the total, then the remainder is
    /// distributed pro-rata per the proposed split.
    /// Either zero is permitted (winner-takes-all is a valid resolution).
    function proposeSplit(uint256 jobId, uint256 buyerAmount, uint256 providerAmount)
        external
        nonReentrant
    {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Disputed) {
            revert InvalidStatus(jobId, JobStatus.Disputed, job.status);
        }
        if (msg.sender != job.buyer && msg.sender != job.provider) {
            revert NotParty();
        }
        if (buyerAmount + providerAmount != job.amount) {
            revert InvalidSplitAmounts(buyerAmount + providerAmount, job.amount);
        }

        bytes32 proposalHash = keccak256(abi.encode(buyerAmount, providerAmount));
        splitProposals[jobId][msg.sender] = proposalHash;

        address other = msg.sender == job.buyer ? job.provider : job.buyer;
        if (splitProposals[jobId][other] == proposalHash) {
            _settleDispute(job, jobId, buyerAmount);
        } else {
            emit SplitProposed(jobId, msg.sender, buyerAmount, providerAmount);
        }
    }

    /// @notice After MAX_JOB_LIFETIME, any unsettled job force-closes.
    /// Branches on status to align with each path's intent:
    ///   - Funded (provider never engaged): full refund to buyer, no fee.
    ///   - Done (provider engaged, buyer silent for 7d): settle to provider
    ///     per claimTimeout semantics. Protects negligent providers from a
    ///     buyer who sleeps on the 24h acceptance window for 6 more days.
    ///   - Disputed (no resolution): full refund to buyer, no fee. Default-
    ///     to-buyer is the documented dispute fallback (project-anima §29.3).
    function forceClose(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status == JobStatus.Settled) revert AlreadySettled(jobId);
        if (block.timestamp < job.createdAt + MAX_JOB_LIFETIME) {
            revert MaxLifetimeNotExpired(jobId);
        }

        emit JobForceClosed(jobId);
        if (job.status == JobStatus.Done) {
            _settle(job, jobId, job.provider);
        } else {
            // Funded or Disputed → full buyer refund
            uint256 amount = job.amount;
            address buyer = job.buyer;
            job.status = JobStatus.Settled;
            _send(buyer, amount);
        }
    }

    // ── Views ──

    function getJob(uint256 jobId) external view returns (Job memory) {
        if (jobId >= jobCount) revert JobNotFound(jobId);
        return _jobs[jobId];
    }

    // ── Internals ──

    function _getJob(uint256 jobId) internal view returns (Job storage) {
        if (jobId >= jobCount) revert JobNotFound(jobId);
        return _jobs[jobId];
    }

    /// @dev Fee is always > 0 here: MIN_JOB_AMOUNT (1e15) * PROTOCOL_FEE_BPS (500)
    /// / BPS_DENOMINATOR (10_000) = 5e13, well above zero. The createJob floor
    /// guarantees this. If MIN_JOB_AMOUNT is ever lowered below 20 wei, restore
    /// a `if (fee > 0)` guard around the feeRecipient send.
    function _settle(Job storage job, uint256 jobId, address recipient) internal {
        uint256 amount = job.amount;
        job.status = JobStatus.Settled;

        uint256 fee = (amount * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        uint256 payout = amount - fee;

        emit JobSettled(jobId, recipient, payout, fee);
        _send(feeRecipient, fee);
        _send(recipient, payout);
    }

    function _settleDispute(Job storage job, uint256 jobId, uint256 buyerAmount) internal {
        uint256 amount = job.amount;
        address buyer = job.buyer;
        address provider = job.provider;
        job.status = JobStatus.Settled;

        uint256 fee = (amount * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        uint256 distributable = amount - fee;

        // Pro-rata distribution. Provider absorbs rounding dust to keep math sane.
        uint256 buyerPayout = (distributable * buyerAmount) / amount;
        uint256 providerPayout = distributable - buyerPayout;

        emit SplitResolved(jobId, buyerPayout, providerPayout, fee);
        _send(feeRecipient, fee);
        if (buyerPayout > 0) _send(buyer, buyerPayout);
        if (providerPayout > 0) _send(provider, providerPayout);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }
}
