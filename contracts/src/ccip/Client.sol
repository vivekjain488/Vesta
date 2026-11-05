// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal vendored copy of Chainlink CCIP's `Client` library. Struct layout and extra-args tags are
///         ABI-identical to the official chainlink contracts-ccip package. Vendored to avoid package-path churn
///         between CCIP releases; swap for the official import if preferred.
library Client {
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    struct Any2EVMMessage {
        bytes32 messageId;
        uint64 sourceChainSelector;
        bytes sender; // abi.encode(sender address)
        bytes data;
        EVMTokenAmount[] destTokenAmounts;
    }

    struct EVM2AnyMessage {
        bytes receiver; // abi.encode(receiver address) for EVM destinations
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken; // address(0) = pay fee in native gas token
        bytes extraArgs;
    }

    // bytes4(keccak256("CCIP EVMExtraArgsV2"))
    bytes4 internal constant EVM_EXTRA_ARGS_V2_TAG = 0x181dcf10;

    struct EVMExtraArgsV2 {
        uint256 gasLimit;
        bool allowOutOfOrderExecution;
    }

    function _argsToBytes(EVMExtraArgsV2 memory extraArgs) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EVM_EXTRA_ARGS_V2_TAG, extraArgs);
    }
}
