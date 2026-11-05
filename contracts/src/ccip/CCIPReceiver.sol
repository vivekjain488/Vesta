// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Client} from "./Client.sol";
import {IAny2EVMMessageReceiver} from "./IRouterClient.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Minimal CCIPReceiver base, behaviourally identical to Chainlink's: only the configured router may
///         deliver messages, and ERC-165 advertises IAny2EVMMessageReceiver so the router calls us.
abstract contract CCIPReceiver is IAny2EVMMessageReceiver, IERC165 {
    address internal immutable i_ccipRouter;

    error InvalidRouter(address router);

    constructor(address router) {
        if (router == address(0)) revert InvalidRouter(address(0));
        i_ccipRouter = router;
    }

    function getRouter() public view returns (address) {
        return i_ccipRouter;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function ccipReceive(Client.Any2EVMMessage calldata message) external virtual override {
        if (msg.sender != i_ccipRouter) revert InvalidRouter(msg.sender);
        _ccipReceive(message);
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal virtual;
}
