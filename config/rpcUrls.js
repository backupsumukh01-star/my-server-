function rpcUrlsFor(network) {
    const extras = {
        eth: ["https://ethereum.publicnode.com", "https://1rpc.io/eth", "https://eth.llamarpc.com"],
        bsc: ["https://bsc-dataseed.binance.org", "https://bsc.publicnode.com"]
    };

    return [...new Set([network.rpcUrl, ...(extras[network.key] || [])].filter(Boolean))];
}

module.exports = {
    rpcUrlsFor
};
