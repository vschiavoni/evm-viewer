// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Counter {
    uint256 public count = 41;

    function increment(uint256 delta) public returns (uint256) {
        count += delta;
        return count;
    }

    function fail() public pure {
        require(false, "Example revert");
    }
}
