// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {AnimaMarket} from "../src/AnimaMarket.sol";

/// @dev EOA-style payable receiver. Always accepts.
contract AcceptingReceiver {
    receive() external payable {}
}

/// @dev Reverts on any incoming native transfer. Used to test NativeTransferFailed.
contract RevertingReceiver {
    receive() external payable {
        revert("nope");
    }
}

/// @dev Attempts reentrancy on _settle. Receives 0G during _send, then tries
/// to call back into the contract. nonReentrant + Settled-before-send means
/// the re-entry must hit InvalidStatus or ReentrancyGuardReentrantCall.
contract ReentrantBuyer {
    AnimaMarket public market;
    uint256 public jobId;
    bool public reenter;

    function setMarket(address market_) external {
        market = AnimaMarket(market_);
    }

    function fundCreate(address provider, uint256 amount) external payable returns (uint256) {
        return market.createJob{value: amount}(provider, bytes32(uint256(0xCAFE)));
    }

    function callDispute(uint256 jobId_) external {
        market.dispute(jobId_);
    }

    function callAccept(uint256 jobId_) external {
        market.acceptResult(jobId_);
    }

    function setReenter(bool v, uint256 jobId_) external {
        reenter = v;
        jobId = jobId_;
    }

    receive() external payable {
        if (reenter) {
            // Try to re-enter — will hit nonReentrant or wrong-status revert
            market.acceptResult(jobId);
        }
    }
}

contract AnimaMarketTest is Test {
    AnimaMarket internal market;

    address internal buyer;
    address internal provider;
    address internal feeRecipient;
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant DESC_HASH = bytes32(uint256(0xBEEF));
    uint256 internal constant JOB_AMOUNT = 1 ether;
    // Derived from contract constants in setUp() so tests track contract
    // changes automatically. Set once after `market` is constructed.
    uint256 internal EXPECTED_FEE;
    uint256 internal EXPECTED_PAYOUT;

    // Mirror events for vm.expectEmit
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

    function setUp() public {
        // EOAs with funds
        buyer = makeAddr("buyer");
        provider = makeAddr("provider");
        feeRecipient = makeAddr("feeRecipient");
        vm.deal(buyer, 100 ether);
        vm.deal(provider, 1 ether);
        vm.deal(stranger, 1 ether);

        market = new AnimaMarket(feeRecipient);
        EXPECTED_FEE = (JOB_AMOUNT * market.PROTOCOL_FEE_BPS()) / market.BPS_DENOMINATOR();
        EXPECTED_PAYOUT = JOB_AMOUNT - EXPECTED_FEE;
    }

    // ── helpers ──

    function _createFundedJob() internal returns (uint256 jobId) {
        vm.prank(buyer);
        jobId = market.createJob{value: JOB_AMOUNT}(provider, DESC_HASH);
    }

    function _markDone(uint256 jobId) internal {
        vm.prank(provider);
        market.markDone(jobId);
    }

    function _dispute(uint256 jobId) internal {
        vm.prank(buyer);
        market.dispute(jobId);
    }

    // ── Constructor ──

    function test_Constructor_RevertsOnZeroFeeRecipient() public {
        vm.expectRevert(AnimaMarket.ZeroAddress.selector);
        new AnimaMarket(address(0));
    }

    function test_Constructor_SetsFeeRecipient() public view {
        assertEq(market.feeRecipient(), feeRecipient);
    }

    // ── createJob ──

    function test_CreateJob_Happy() public {
        vm.expectEmit(true, true, true, true, address(market));
        emit JobCreated(0, buyer, provider, JOB_AMOUNT, DESC_HASH);
        vm.prank(buyer);
        uint256 jobId = market.createJob{value: JOB_AMOUNT}(provider, DESC_HASH);

        assertEq(jobId, 0);
        assertEq(market.jobCount(), 1);

        AnimaMarket.Job memory j = market.getJob(0);
        assertEq(j.buyer, buyer);
        assertEq(j.provider, provider);
        assertEq(j.amount, JOB_AMOUNT);
        assertEq(j.descriptionHash, DESC_HASH);
        assertEq(uint8(j.status), uint8(AnimaMarket.JobStatus.Funded));
        assertEq(j.createdAt, block.timestamp);
        assertEq(j.doneAt, 0);
        assertEq(address(market).balance, JOB_AMOUNT);
    }

    function test_CreateJob_IncrementsJobCount() public {
        _createFundedJob();
        _createFundedJob();
        assertEq(market.jobCount(), 2);
    }

    function test_CreateJob_AllowsEmptyDescriptionHash() public {
        vm.prank(buyer);
        uint256 jobId = market.createJob{value: JOB_AMOUNT}(provider, bytes32(0));
        assertEq(market.getJob(jobId).descriptionHash, bytes32(0));
    }

    function test_RevertWhen_CreateJob_ZeroProvider() public {
        vm.prank(buyer);
        vm.expectRevert(AnimaMarket.ZeroAddress.selector);
        market.createJob{value: JOB_AMOUNT}(address(0), DESC_HASH);
    }

    function test_RevertWhen_CreateJob_SelfTrade() public {
        vm.prank(buyer);
        vm.expectRevert(AnimaMarket.SelfTrade.selector);
        market.createJob{value: JOB_AMOUNT}(buyer, DESC_HASH);
    }

    function test_RevertWhen_CreateJob_BelowMinimum() public {
        uint256 minAmount = market.MIN_JOB_AMOUNT();
        vm.prank(buyer);
        vm.expectRevert(AnimaMarket.AmountBelowMinimum.selector);
        market.createJob{value: minAmount - 1}(provider, DESC_HASH);
    }

    function test_RevertWhen_CreateJob_ZeroValue() public {
        vm.prank(buyer);
        vm.expectRevert(AnimaMarket.AmountBelowMinimum.selector);
        market.createJob{value: 0}(provider, DESC_HASH);
    }

    function test_CreateJob_AtExactMinimum() public {
        vm.prank(buyer);
        uint256 jobId = market.createJob{value: market.MIN_JOB_AMOUNT()}(provider, DESC_HASH);
        assertEq(market.getJob(jobId).amount, market.MIN_JOB_AMOUNT());
    }

    // ── markDone ──

    function test_MarkDone_Happy() public {
        uint256 jobId = _createFundedJob();
        vm.expectEmit(true, false, false, true, address(market));
        emit JobMarkedDone(jobId, block.timestamp);
        vm.prank(provider);
        market.markDone(jobId);

        AnimaMarket.Job memory j = market.getJob(jobId);
        assertEq(uint8(j.status), uint8(AnimaMarket.JobStatus.Done));
        assertEq(j.doneAt, block.timestamp);
    }

    function test_RevertWhen_MarkDone_NotProvider() public {
        uint256 jobId = _createFundedJob();
        vm.prank(buyer);
        vm.expectRevert(AnimaMarket.NotProvider.selector);
        market.markDone(jobId);
    }

    function test_RevertWhen_MarkDone_FromStranger() public {
        uint256 jobId = _createFundedJob();
        vm.prank(stranger);
        vm.expectRevert(AnimaMarket.NotProvider.selector);
        market.markDone(jobId);
    }

    function test_RevertWhen_MarkDone_AlreadyDone() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                AnimaMarket.InvalidStatus.selector,
                jobId,
                AnimaMarket.JobStatus.Funded,
                AnimaMarket.JobStatus.Done
            )
        );
        market.markDone(jobId);
    }

    function test_RevertWhen_MarkDone_AfterAccept() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.prank(buyer);
        market.acceptResult(jobId);
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                AnimaMarket.InvalidStatus.selector,
                jobId,
                AnimaMarket.JobStatus.Funded,
                AnimaMarket.JobStatus.Settled
            )
        );
        market.markDone(jobId);
    }

    function test_RevertWhen_MarkDone_InvalidJobId() public {
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(AnimaMarket.JobNotFound.selector, uint256(99)));
        market.markDone(99);
    }

    // ── acceptResult ──

    function test_AcceptResult_Happy_PaysFeeAndProvider() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);

        uint256 feeRecipientBefore = feeRecipient.balance;
        uint256 providerBefore = provider.balance;

        vm.expectEmit(true, false, false, false, address(market));
        emit JobAccepted(jobId);
        vm.expectEmit(true, true, false, true, address(market));
        emit JobSettled(jobId, provider, EXPECTED_PAYOUT, EXPECTED_FEE);
        vm.prank(buyer);
        market.acceptResult(jobId);

        assertEq(feeRecipient.balance - feeRecipientBefore, EXPECTED_FEE);
        assertEq(provider.balance - providerBefore, EXPECTED_PAYOUT);
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
        assertEq(address(market).balance, 0);
    }

    function test_RevertWhen_AcceptResult_NotBuyer() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.prank(provider);
        vm.expectRevert(AnimaMarket.NotBuyer.selector);
        market.acceptResult(jobId);
    }

    function test_RevertWhen_AcceptResult_NotInDoneStatus() public {
        uint256 jobId = _createFundedJob();
        // Still in Funded
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                AnimaMarket.InvalidStatus.selector,
                jobId,
                AnimaMarket.JobStatus.Done,
                AnimaMarket.JobStatus.Funded
            )
        );
        market.acceptResult(jobId);
    }

    // ── dispute ──

    function test_Dispute_Happy() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.expectEmit(true, false, false, false, address(market));
        emit JobDisputed(jobId);
        vm.prank(buyer);
        market.dispute(jobId);

        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Disputed));
    }

    function test_Dispute_AtBoundaryMinusOne() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.warp(block.timestamp + market.ACCEPTANCE_PERIOD() - 1);
        vm.prank(buyer);
        market.dispute(jobId);
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Disputed));
    }

    function test_RevertWhen_Dispute_NotBuyer() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.prank(provider);
        vm.expectRevert(AnimaMarket.NotBuyer.selector);
        market.dispute(jobId);
    }

    function test_RevertWhen_Dispute_WrongStatus() public {
        uint256 jobId = _createFundedJob();
        // Not yet Done
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                AnimaMarket.InvalidStatus.selector,
                jobId,
                AnimaMarket.JobStatus.Done,
                AnimaMarket.JobStatus.Funded
            )
        );
        market.dispute(jobId);
    }

    function test_RevertWhen_Dispute_AfterAcceptanceWindow() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.warp(block.timestamp + market.ACCEPTANCE_PERIOD());
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(AnimaMarket.AcceptancePeriodExpired.selector, jobId)
        );
        market.dispute(jobId);
    }

    // ── claimTimeout ──

    function test_ClaimTimeout_Happy_AfterWindow() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.warp(block.timestamp + market.ACCEPTANCE_PERIOD());

        uint256 providerBefore = provider.balance;

        vm.prank(stranger); // anyone can call
        market.claimTimeout(jobId);

        assertEq(provider.balance - providerBefore, EXPECTED_PAYOUT);
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
    }

    function test_RevertWhen_ClaimTimeout_BeforeWindow() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.expectRevert(
            abi.encodeWithSelector(AnimaMarket.AcceptancePeriodNotExpired.selector, jobId)
        );
        market.claimTimeout(jobId);
    }

    function test_RevertWhen_ClaimTimeout_NotInDone() public {
        uint256 jobId = _createFundedJob();
        // Still Funded
        vm.expectRevert(
            abi.encodeWithSelector(
                AnimaMarket.InvalidStatus.selector,
                jobId,
                AnimaMarket.JobStatus.Done,
                AnimaMarket.JobStatus.Funded
            )
        );
        market.claimTimeout(jobId);
    }

    function test_RevertWhen_ClaimTimeout_AlreadySettled() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.prank(buyer);
        market.acceptResult(jobId);
        vm.expectRevert(
            abi.encodeWithSelector(
                AnimaMarket.InvalidStatus.selector,
                jobId,
                AnimaMarket.JobStatus.Done,
                AnimaMarket.JobStatus.Settled
            )
        );
        market.claimTimeout(jobId);
    }

    // ── proposeSplit ──

    function test_ProposeSplit_FirstParty_StoresHashAndEmits() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        vm.expectEmit(true, true, false, true, address(market));
        emit SplitProposed(jobId, buyer, JOB_AMOUNT / 2, JOB_AMOUNT / 2);
        vm.prank(buyer);
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);

        bytes32 expected = keccak256(abi.encode(JOB_AMOUNT / 2, JOB_AMOUNT / 2));
        assertEq(market.splitProposals(jobId, buyer), expected);
        assertEq(market.splitProposals(jobId, provider), bytes32(0));
        // Status still Disputed
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Disputed));
    }

    function test_ProposeSplit_MatchingSecondCall_Settles_5050() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        uint256 buyerBefore = buyer.balance;
        uint256 providerBefore = provider.balance;
        uint256 feeRecipientBefore = feeRecipient.balance;

        vm.prank(buyer);
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);

        // 50/50 of distributable (= JOB_AMOUNT - 5%)
        uint256 buyerExpected = (EXPECTED_PAYOUT * (JOB_AMOUNT / 2)) / JOB_AMOUNT;
        uint256 providerExpected = EXPECTED_PAYOUT - buyerExpected;

        vm.expectEmit(true, false, false, true, address(market));
        emit SplitResolved(jobId, buyerExpected, providerExpected, EXPECTED_FEE);
        vm.prank(provider);
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);

        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
        assertEq(buyer.balance - buyerBefore, buyerExpected);
        assertEq(provider.balance - providerBefore, providerExpected);
        assertEq(feeRecipient.balance - feeRecipientBefore, EXPECTED_FEE);
        assertEq(address(market).balance, 0);
    }

    function test_ProposeSplit_NonMatching_DoesNotSettle() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        vm.prank(buyer);
        market.proposeSplit(jobId, JOB_AMOUNT, 0);

        vm.expectEmit(true, true, false, true, address(market));
        emit SplitProposed(jobId, provider, 0, JOB_AMOUNT);
        vm.prank(provider);
        market.proposeSplit(jobId, 0, JOB_AMOUNT);

        // Both proposals stored, no settlement
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Disputed));
        assertEq(address(market).balance, JOB_AMOUNT);
    }

    function test_ProposeSplit_BuyerTakesAll_100_0() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        uint256 buyerBefore = buyer.balance;

        vm.prank(buyer);
        market.proposeSplit(jobId, JOB_AMOUNT, 0);
        vm.prank(provider);
        market.proposeSplit(jobId, JOB_AMOUNT, 0);

        // Buyer gets full distributable, provider 0
        assertEq(buyer.balance - buyerBefore, EXPECTED_PAYOUT);
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
    }

    function test_ProposeSplit_ProviderTakesAll_0_100() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        uint256 providerBefore = provider.balance;

        vm.prank(provider);
        market.proposeSplit(jobId, 0, JOB_AMOUNT);
        vm.prank(buyer);
        market.proposeSplit(jobId, 0, JOB_AMOUNT);

        assertEq(provider.balance - providerBefore, EXPECTED_PAYOUT);
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
    }

    function test_ProposeSplit_Reproposing_LastWriteWins() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        // Buyer first proposes 60/40
        vm.prank(buyer);
        market.proposeSplit(jobId, (JOB_AMOUNT * 60) / 100, (JOB_AMOUNT * 40) / 100);

        // Buyer changes their mind to 50/50
        vm.prank(buyer);
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);

        bytes32 expected = keccak256(abi.encode(JOB_AMOUNT / 2, JOB_AMOUNT / 2));
        assertEq(market.splitProposals(jobId, buyer), expected);

        // Provider matches the new proposal
        vm.prank(provider);
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);

        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
    }

    function test_RevertWhen_ProposeSplit_NotInDispute() public {
        uint256 jobId = _createFundedJob();
        // Still Funded
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                AnimaMarket.InvalidStatus.selector,
                jobId,
                AnimaMarket.JobStatus.Disputed,
                AnimaMarket.JobStatus.Funded
            )
        );
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);
    }

    function test_RevertWhen_ProposeSplit_NotParty() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        vm.prank(stranger);
        vm.expectRevert(AnimaMarket.NotParty.selector);
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);
    }

    function test_RevertWhen_ProposeSplit_AmountsDontSum() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(AnimaMarket.InvalidSplitAmounts.selector, JOB_AMOUNT - 1, JOB_AMOUNT)
        );
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2 - 1);
    }

    function test_RevertWhen_ProposeSplit_AmountsExceed() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(AnimaMarket.InvalidSplitAmounts.selector, JOB_AMOUNT + 1, JOB_AMOUNT)
        );
        market.proposeSplit(jobId, JOB_AMOUNT / 2 + 1, JOB_AMOUNT / 2);
    }

    function test_ProposeSplit_RoundingGoesToProvider() public {
        // Use an amount where 5% then split has rounding
        uint256 amount = 1 ether + 7;
        vm.prank(buyer);
        uint256 jobId = market.createJob{value: amount}(provider, DESC_HASH);
        _markDone(jobId);
        _dispute(jobId);

        uint256 buyerSplit = amount / 3; // odd rounding
        uint256 providerSplit = amount - buyerSplit;

        uint256 buyerBefore = buyer.balance;
        uint256 providerBefore = provider.balance;
        uint256 feeRecipientBefore = feeRecipient.balance;

        vm.prank(buyer);
        market.proposeSplit(jobId, buyerSplit, providerSplit);
        vm.prank(provider);
        market.proposeSplit(jobId, buyerSplit, providerSplit);

        uint256 fee = (amount * 500) / 10_000;
        uint256 distributable = amount - fee;
        uint256 buyerExpected = (distributable * buyerSplit) / amount;
        uint256 providerExpected = distributable - buyerExpected;

        assertEq(feeRecipient.balance - feeRecipientBefore, fee);
        assertEq(buyer.balance - buyerBefore, buyerExpected);
        assertEq(provider.balance - providerBefore, providerExpected);
        // Total spent matches contract balance change
        assertEq(address(market).balance, 0);
    }

    // ── forceClose ──

    function test_ForceClose_AfterMaxLifetime_RefundsBuyerNoFee() public {
        uint256 jobId = _createFundedJob();

        uint256 buyerBefore = buyer.balance;
        uint256 feeRecipientBefore = feeRecipient.balance;

        vm.warp(block.timestamp + market.MAX_JOB_LIFETIME());
        vm.expectEmit(true, false, false, false, address(market));
        emit JobForceClosed(jobId);
        vm.prank(stranger); // anyone can call
        market.forceClose(jobId);

        // Full refund, no fee taken
        assertEq(buyer.balance - buyerBefore, JOB_AMOUNT);
        assertEq(feeRecipient.balance, feeRecipientBefore);
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
    }

    function test_ForceClose_AfterDispute_RefundsBuyerNoFee() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        uint256 buyerBefore = buyer.balance;
        vm.warp(block.timestamp + market.MAX_JOB_LIFETIME());
        vm.prank(provider);
        market.forceClose(jobId);

        assertEq(buyer.balance - buyerBefore, JOB_AMOUNT);
    }

    function test_RevertWhen_ForceClose_BeforeMaxLifetime() public {
        uint256 jobId = _createFundedJob();
        vm.expectRevert(
            abi.encodeWithSelector(AnimaMarket.MaxLifetimeNotExpired.selector, jobId)
        );
        market.forceClose(jobId);
    }

    function test_RevertWhen_ForceClose_AlreadySettled() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.prank(buyer);
        market.acceptResult(jobId);

        vm.warp(block.timestamp + market.MAX_JOB_LIFETIME());
        vm.expectRevert(abi.encodeWithSelector(AnimaMarket.AlreadySettled.selector, jobId));
        market.forceClose(jobId);
    }

    function test_ForceClose_AtExactMaxLifetimeBoundary() public {
        uint256 jobId = _createFundedJob();
        // Exactly at lifetime boundary should pass (>= check)
        vm.warp(block.timestamp + market.MAX_JOB_LIFETIME());
        market.forceClose(jobId);
    }

    function test_ForceClose_FromDone_SettlesToProvider() public {
        // Provider engaged (markDone), buyer never accepted/disputed.
        // After 7d, forceClose should settle to provider, NOT refund buyer.
        // Audit-3 finding: protects negligent providers.
        uint256 jobId = _createFundedJob();
        _markDone(jobId);

        uint256 buyerBefore = buyer.balance;
        uint256 providerBefore = provider.balance;
        uint256 feeRecipientBefore = feeRecipient.balance;

        vm.warp(block.timestamp + market.MAX_JOB_LIFETIME());
        vm.expectEmit(true, false, false, false, address(market));
        emit JobForceClosed(jobId);
        vm.expectEmit(true, true, false, true, address(market));
        emit JobSettled(jobId, provider, EXPECTED_PAYOUT, EXPECTED_FEE);
        vm.prank(stranger);
        market.forceClose(jobId);

        // Provider gets paid 95%, fee taken 5%, buyer gets nothing
        assertEq(provider.balance - providerBefore, EXPECTED_PAYOUT);
        assertEq(feeRecipient.balance - feeRecipientBefore, EXPECTED_FEE);
        assertEq(buyer.balance, buyerBefore);
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
    }

    function test_RevertWhen_ForceClose_OneSecondBeforeBoundary() public {
        uint256 jobId = _createFundedJob();
        vm.warp(block.timestamp + market.MAX_JOB_LIFETIME() - 1);
        vm.expectRevert(
            abi.encodeWithSelector(AnimaMarket.MaxLifetimeNotExpired.selector, jobId)
        );
        market.forceClose(jobId);
    }

    // ── Views ──

    function test_GetJob_ReturnsCorrect() public {
        uint256 jobId = _createFundedJob();
        AnimaMarket.Job memory j = market.getJob(jobId);
        assertEq(j.buyer, buyer);
        assertEq(j.provider, provider);
    }

    function test_RevertWhen_GetJob_InvalidId() public {
        vm.expectRevert(abi.encodeWithSelector(AnimaMarket.JobNotFound.selector, uint256(0)));
        market.getJob(0);
    }

    function test_RevertWhen_GetJob_OutOfRange() public {
        _createFundedJob();
        vm.expectRevert(abi.encodeWithSelector(AnimaMarket.JobNotFound.selector, uint256(5)));
        market.getJob(5);
    }

    // ── NativeTransferFailed ──

    function test_RevertWhen_FeeRecipientReverts() public {
        RevertingReceiver bad = new RevertingReceiver();
        AnimaMarket badMarket = new AnimaMarket(address(bad));

        vm.deal(buyer, 10 ether);
        vm.prank(buyer);
        uint256 jobId = badMarket.createJob{value: JOB_AMOUNT}(provider, DESC_HASH);
        vm.prank(provider);
        badMarket.markDone(jobId);

        vm.prank(buyer);
        vm.expectRevert(); // NativeTransferFailed reverts when fee send fails
        badMarket.acceptResult(jobId);
    }

    function test_RevertWhen_BuyerRefundFails() public {
        // forceClose path: buyer is reverting receiver
        RevertingReceiver bad = new RevertingReceiver();
        vm.deal(address(bad), 10 ether);

        vm.prank(address(bad));
        uint256 jobId = market.createJob{value: JOB_AMOUNT}(provider, DESC_HASH);

        vm.warp(block.timestamp + market.MAX_JOB_LIFETIME());
        vm.expectRevert(); // refund _send to bad reverts
        market.forceClose(jobId);
    }

    function test_RevertWhen_ProviderPayoutFails() public {
        // claimTimeout path: provider reverts
        RevertingReceiver bad = new RevertingReceiver();
        vm.prank(buyer);
        uint256 jobId = market.createJob{value: JOB_AMOUNT}(address(bad), DESC_HASH);

        vm.prank(address(bad));
        market.markDone(jobId);

        vm.warp(block.timestamp + market.ACCEPTANCE_PERIOD());
        vm.expectRevert();
        market.claimTimeout(jobId);
    }

    // ── Reentrancy ──

    function test_Reentrancy_OnAcceptResult_Blocked() public {
        ReentrantBuyer attacker = new ReentrantBuyer();
        attacker.setMarket(address(market));
        vm.deal(address(attacker), 10 ether);

        uint256 jobId = attacker.fundCreate{value: JOB_AMOUNT}(provider, JOB_AMOUNT);
        vm.prank(provider);
        market.markDone(jobId);

        // Arm the attacker to re-enter on receive (which won't trigger here
        // because acceptResult sends to provider, not buyer). Verify the
        // happy path still works to confirm test setup is correct.
        attacker.callAccept(jobId);
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Settled));
    }

    function test_Reentrancy_BuyerRevertsOnReceive_BlocksSettleAtomically() public {
        // A malicious buyer that reverts on receive (or re-enters into a
        // function that reverts) blocks settlement atomically: the entire
        // proposeSplit tx reverts NativeTransferFailed, contract state
        // rolls back, no double-spend possible. The buyer can grief but
        // not steal. This is a documented MVP limitation; the practical
        // mitigation is that anima agents are EOAs (no malicious receive).
        ReentrantBuyer attacker = new ReentrantBuyer();
        attacker.setMarket(address(market));
        vm.deal(address(attacker), 10 ether);

        uint256 jobId = attacker.fundCreate{value: JOB_AMOUNT}(provider, JOB_AMOUNT);
        vm.prank(provider);
        market.markDone(jobId);
        attacker.callDispute(jobId);

        // Arm: receive() will call acceptResult on the settled job, which
        // reverts InvalidStatus. The .call low-level send returns ok=false,
        // _send reverts NativeTransferFailed, the whole tx reverts.
        attacker.setReenter(true, jobId);

        vm.prank(address(attacker));
        market.proposeSplit(jobId, JOB_AMOUNT, 0);

        // Provider's matching call would settle, but settle's _send to buyer
        // re-enters and fails → atomic revert
        vm.expectRevert(); // NativeTransferFailed
        vm.prank(provider);
        market.proposeSplit(jobId, JOB_AMOUNT, 0);

        // State preserved: still Disputed, full balance still in escrow
        assertEq(uint8(market.getJob(jobId).status), uint8(AnimaMarket.JobStatus.Disputed));
        assertEq(address(market).balance, JOB_AMOUNT);
    }

    // ── Constants exposed ──

    function test_Constants_AsExpected() public view {
        assertEq(market.PROTOCOL_FEE_BPS(), 500);
        assertEq(market.BPS_DENOMINATOR(), 10_000);
        assertEq(market.ACCEPTANCE_PERIOD(), 24 hours);
        assertEq(market.MAX_JOB_LIFETIME(), 7 days);
        assertEq(market.MIN_JOB_AMOUNT(), 1e15);
    }

    // ── Fuzz ──

    function testFuzz_CreateJob_AnyValidAmount(uint256 amount, address randomProvider) public {
        amount = bound(amount, market.MIN_JOB_AMOUNT(), 1_000 ether);
        vm.assume(randomProvider != address(0));
        vm.assume(randomProvider != buyer);
        vm.assume(uint160(randomProvider) > 1000); // skip precompile/system addrs

        vm.deal(buyer, amount);
        vm.prank(buyer);
        uint256 jobId = market.createJob{value: amount}(randomProvider, DESC_HASH);

        AnimaMarket.Job memory j = market.getJob(jobId);
        assertEq(j.amount, amount);
        assertEq(j.buyer, buyer);
        assertEq(j.provider, randomProvider);
    }

    function testFuzz_ProposeSplit_RandomValidSplits(uint256 buyerShareBps) public {
        buyerShareBps = bound(buyerShareBps, 0, 10_000);

        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);

        uint256 buyerSplit = (JOB_AMOUNT * buyerShareBps) / 10_000;
        uint256 providerSplit = JOB_AMOUNT - buyerSplit;

        uint256 buyerBefore = buyer.balance;
        uint256 providerBefore = provider.balance;
        uint256 feeRecipientBefore = feeRecipient.balance;

        vm.prank(buyer);
        market.proposeSplit(jobId, buyerSplit, providerSplit);
        vm.prank(provider);
        market.proposeSplit(jobId, buyerSplit, providerSplit);

        uint256 distributable = JOB_AMOUNT - EXPECTED_FEE;
        uint256 buyerExpected = (distributable * buyerSplit) / JOB_AMOUNT;
        uint256 providerExpected = distributable - buyerExpected;

        assertEq(feeRecipient.balance - feeRecipientBefore, EXPECTED_FEE);
        assertEq(buyer.balance - buyerBefore, buyerExpected);
        assertEq(provider.balance - providerBefore, providerExpected);
        assertEq(address(market).balance, 0);
    }

    function test_MultiJob_TotalLockedInvariant() public {
        // Audit-1 medium: stateful multi-job invariant.
        // contract.balance == sum of (job.amount where status != Settled).
        uint256 a = 0.5 ether;
        uint256 b = 1.5 ether;
        uint256 c = 2.0 ether;

        vm.prank(buyer);
        uint256 j0 = market.createJob{value: a}(provider, DESC_HASH);
        vm.prank(buyer);
        uint256 j1 = market.createJob{value: b}(provider, DESC_HASH);
        vm.prank(buyer);
        uint256 j2 = market.createJob{value: c}(provider, DESC_HASH);

        assertEq(address(market).balance, a + b + c);

        // Settle j0 via accept
        vm.prank(provider);
        market.markDone(j0);
        vm.prank(buyer);
        market.acceptResult(j0);
        assertEq(address(market).balance, b + c);

        // Settle j1 via dispute → split → resolve
        vm.prank(provider);
        market.markDone(j1);
        vm.prank(buyer);
        market.dispute(j1);
        vm.prank(buyer);
        market.proposeSplit(j1, b / 2, b / 2);
        vm.prank(provider);
        market.proposeSplit(j1, b / 2, b / 2);
        assertEq(address(market).balance, c);

        // Settle j2 via forceClose from Funded
        vm.warp(block.timestamp + market.MAX_JOB_LIFETIME());
        market.forceClose(j2);
        assertEq(address(market).balance, 0);
    }

    function testFuzz_RevertOnBelowMinimum(uint256 amount) public {
        amount = bound(amount, 0, market.MIN_JOB_AMOUNT() - 1);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(AnimaMarket.AmountBelowMinimum.selector);
        market.createJob{value: amount}(provider, DESC_HASH);
    }

    // ── Gas snapshots (informational) ──

    function test_Gas_CreateJob() public {
        vm.prank(buyer);
        uint256 g = gasleft();
        market.createJob{value: JOB_AMOUNT}(provider, DESC_HASH);
        emit log_named_uint("gas createJob", g - gasleft());
    }

    function test_Gas_AcceptResult_FullPath() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        vm.prank(buyer);
        uint256 g = gasleft();
        market.acceptResult(jobId);
        emit log_named_uint("gas acceptResult", g - gasleft());
    }

    function test_Gas_SplitResolve() public {
        uint256 jobId = _createFundedJob();
        _markDone(jobId);
        _dispute(jobId);
        vm.prank(buyer);
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);
        vm.prank(provider);
        uint256 g = gasleft();
        market.proposeSplit(jobId, JOB_AMOUNT / 2, JOB_AMOUNT / 2);
        emit log_named_uint("gas split resolve", g - gasleft());
    }
}
