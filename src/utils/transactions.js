const axios = require('axios');
const BigNumber = require('bignumber.js');
const { payments, networks } = require('bitcoinjs-lib');
const {
  deriveChildPublicKey,
  blockExplorerAPIURL,
  generateMultisigFromPublicKeys,
} = require("unchained-bitcoin");

const getMultisigDeriationPathForNetwork = (network) => {
  if (network === networks.bitcoin) {
    return "m/48'/0'/0'/2'"
  } else if (network === networks.testnet) {
    return "m/48'/1'/0'/2'"
  } else { // return mainnet by default...this should never run though
    return "m/48'/0'/0'/2'"
  }
}

const getUnchainedNetworkFromBjslibNetwork = (bitcoinJslibNetwork) => {
  if (bitcoinJslibNetwork === networks.bitcoin) {
    return 'mainnet';
  } else {
    return 'testnet';
  }
}

const createAddressMapFromAddressArray = (addressArray) => {
  const addressMap = new Map();
  addressArray.forEach((addr) => {
    addressMap.set(addr.address, addr)
  });
  return addressMap
}

const serializeTransactions = (transactionsFromBlockstream, addresses, changeAddresses) => {
  const changeAddressesMap = createAddressMapFromAddressArray(changeAddresses);
  const addressesMap = createAddressMapFromAddressArray(addresses);

  transactionsFromBlockstream.sort((a, b) => a.status.block_time - b.status.block_time);

  let currentAccountTotal = BigNumber(0);
  const transactions = new Map();
  for (let i = 0; i < transactionsFromBlockstream.length; i++) {
    // examine outputs and filter out ouputs that are change addresses back to us
    let transactionPushed = false;
    let possibleTransactions = new Map();
    for (let j = 0; j < transactionsFromBlockstream[i].vout.length; j++) {
      if (addressesMap.get(transactionsFromBlockstream[i].vout[j].scriptpubkey_address)) {
        // received payment
        const transactionWithValues = transactionsFromBlockstream[i];
        transactionWithValues.value = transactionsFromBlockstream[i].vout[j].value;
        transactionWithValues.address = addressesMap.get(transactionsFromBlockstream[i].vout[j].scriptpubkey_address);
        transactionWithValues.type = 'received';
        transactionWithValues.totalValue = currentAccountTotal.plus(transactionsFromBlockstream[i].vout[j].value).toNumber();
        transactions.set(transactionsFromBlockstream[i].txid, transactionWithValues);
        transactionPushed = true;
        currentAccountTotal = currentAccountTotal.plus(transactionsFromBlockstream[i].vout[j].value)
      } else if (changeAddressesMap.get(transactionsFromBlockstream[i].vout[j].scriptpubkey_address)) {



      } else {
        // either outgoing payment or sender change address
        if (!transactions.get(transactionsFromBlockstream[i].txid)) {
          const transactionWithValues = transactionsFromBlockstream[i];
          transactionWithValues.value = transactionsFromBlockstream[i].vout[j].value;
          transactionWithValues.address = transactionsFromBlockstream[i].vout[j].scriptpubkey_address;
          transactionWithValues.type = 'sent';
          transactionWithValues.totalValue = currentAccountTotal.minus(transactionsFromBlockstream[i].vout[j].value + transactionsFromBlockstream[i].fee).toNumber();
          possibleTransactions.set(transactionsFromBlockstream[i].txid, transactionWithValues)
        }
      }
    }

    if (!transactionPushed) {
      const possibleTransactionsIterator = possibleTransactions.entries();
      for (let i = 0; i < possibleTransactions.size; i++) {
        const possibleTx = possibleTransactionsIterator.next().value;
        currentAccountTotal = currentAccountTotal.minus(possibleTx[1].vout.reduce((accum, vout) => {
          if (!changeAddressesMap.get(vout.scriptpubkey_address)) {
            return accum.plus(vout.value);
          }
          return accum;
        }, BigNumber(0))).minus(possibleTx[1].fee);
        transactions.set(possibleTx[0], possibleTx[1]);
      }
    }
  }

  const transactionsIterator = transactions.values();
  const transactionsArray = [];
  for (let i = 0; i < transactions.size; i++) {
    transactionsArray.push(transactionsIterator.next().value);
  }

  transactionsArray.sort((a, b) => b.status.block_time - a.status.block_time);
  return transactionsArray;
}

const getChildPubKeysFromXpubs = (xpubs, multisig = true, currentBitcoinNetwork) => {
  const childPubKeys = [];
  for (let i = 0; i < 30; i++) {
    xpubs.forEach((xpub) => {
      const childPubKeysBip32Path = `m/0/${i}`;
      const bip32derivationPath = multisig ? `${getMultisigDeriationPathForNetwork(currentBitcoinNetwork)}/${childPubKeysBip32Path.replace('m/', '')}` : `m/84'/0'/0'/${childPubKeysBip32Path.replace('m/', '')}`;
      childPubKeys.push({
        childPubKey: deriveChildPublicKey(xpub.xpub, childPubKeysBip32Path, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)),
        bip32derivation: {
          masterFingerprint: Buffer.from(xpub.parentFingerprint, 'hex'),
          pubkey: Buffer.from(deriveChildPublicKey(xpub.xpub, childPubKeysBip32Path, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)), 'hex'),
          path: bip32derivationPath
        }
      });
    })
  }
  return childPubKeys;
}

const getChildChangePubKeysFromXpubs = (xpubs, multisig = true, currentBitcoinNetwork) => {
  const childChangePubKeys = [];
  for (let i = 0; i < 30; i++) {
    xpubs.forEach((xpub) => {
      const childChangeAddressPubKeysBip32Path = `m/1/${i}`;
      const bip32derivationPath = multisig ? `${getMultisigDeriationPathForNetwork(currentBitcoinNetwork)}/${childChangeAddressPubKeysBip32Path.replace('m/', '')}` : `m/84'/0'/0'/${childChangeAddressPubKeysBip32Path.replace('m/', '')}`;
      childChangePubKeys.push({
        childPubKey: deriveChildPublicKey(xpub.xpub, childChangeAddressPubKeysBip32Path, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)),
        bip32derivation: {
          masterFingerprint: Buffer.from(xpub.parentFingerprint, 'hex'),
          pubkey: Buffer.from(deriveChildPublicKey(xpub.xpub, childChangeAddressPubKeysBip32Path, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)), 'hex'),
          path: bip32derivationPath,
        }
      });
    })
  }
  return childChangePubKeys;
}

const getMultisigAddressesFromPubKeys = (pubkeys, config, currentBitcoinNetwork) => {
  const addresses = [];
  for (let i = 0; i < pubkeys.length; i + 3) {
    const publicKeysForMultisigAddress = pubkeys.splice(i, 3);
    const rawPubkeys = publicKeysForMultisigAddress.map((publicKey) => publicKey.childPubKey);
    rawPubkeys.sort();
    const address = generateMultisigFromPublicKeys(getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork), config.addressType, config.quorum.requiredSigners, rawPubkeys[0], rawPubkeys[1], rawPubkeys[2]);
    address.bip32derivation = publicKeysForMultisigAddress.map((publicKey) => publicKey.bip32derivation)
    addresses.push(address);
  }
  return addresses;
}

const getTransactionsFromAddresses = async (addresses, currentBitcoinNetwork) => {
  const transactions = [];
  for (let i = 0; i < addresses.length; i++) {
    const txsFromBlockstream = await (await axios.get(blockExplorerAPIURL(`/address/${addresses[i].address}/txs`, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)))).data;
    txsFromBlockstream.forEach((tx) => {
      transactions.push(tx);
    })
  }
  return transactions;
}

const getUnusedAddresses = async (addresses, currentBitcoinNetwork) => {
  const unusedAddresses = [];
  for (let i = 0; i < addresses.length; i++) {
    const txsFromBlockstream = await (await axios.get(blockExplorerAPIURL(`/address/${addresses[i].address}/txs`, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)))).data;
    if (!txsFromBlockstream.length > 0) {
      unusedAddresses.push(addresses[i]);
    }
  }
  return unusedAddresses;
}

const getUtxosForAddresses = async (addresses, currentBitcoinNetwork) => {
  const availableUtxos = [];
  for (let i = 0; i < addresses.length; i++) {
    const utxosFromBlockstream = await (await axios.get(blockExplorerAPIURL(`/address/${addresses[i].address}/utxo`, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)))).data;
    for (let j = 0; j < utxosFromBlockstream.length; j++) {
      const utxo = utxosFromBlockstream[j];
      utxo.address = addresses[i];
      availableUtxos.push(utxo)
    }
  }

  return availableUtxos;
}

const getDataFromMultisig = async (config, currentBitcoinNetwork) => {
  const childPubKeys = getChildPubKeysFromXpubs(config.extendedPublicKeys, true, currentBitcoinNetwork);
  const childChangePubKeys = getChildChangePubKeysFromXpubs(config.extendedPublicKeys, true, currentBitcoinNetwork);

  const addresses = getMultisigAddressesFromPubKeys(childPubKeys, config, currentBitcoinNetwork);
  const changeAddresses = getMultisigAddressesFromPubKeys(childChangePubKeys, config, currentBitcoinNetwork);

  const transactions = await getTransactionsFromAddresses(addresses.concat(changeAddresses), currentBitcoinNetwork);
  const unusedAddresses = await getUnusedAddresses(addresses, currentBitcoinNetwork);
  const unusedChangeAddresses = await getUnusedAddresses(changeAddresses, currentBitcoinNetwork);

  const availableUtxos = await getUtxosForAddresses(addresses.concat(changeAddresses), currentBitcoinNetwork);

  const organizedTransactions = serializeTransactions(transactions, addresses, changeAddresses);

  return [addresses, changeAddresses, organizedTransactions, unusedAddresses, unusedChangeAddresses, availableUtxos];
}

const getDataFromXPub = async (currentWallet, currentBitcoinNetwork) => {
  const childPubKeys = getChildPubKeysFromXpubs([currentWallet], false, currentBitcoinNetwork);
  const childChangePubKeys = getChildChangePubKeysFromXpubs([currentWallet], false, currentBitcoinNetwork);

  const addresses = childPubKeys.map((childPubKey, i) => {
    const address = payments.p2wpkh({ pubkey: Buffer.from(childPubKey.childPubKey, 'hex'), network: currentBitcoinNetwork });
    address.bip32derivation = [childPubKey.bip32derivation];
    return address;
  });

  const changeAddresses = childChangePubKeys.map((childPubKey, i) => {
    const address = payments.p2wpkh({ pubkey: Buffer.from(childPubKey.childPubKey, 'hex'), network: currentBitcoinNetwork });
    address.bip32derivation = [childPubKey.bip32derivation];
    return address;
  });

  const transactions = await getTransactionsFromAddresses(addresses.concat(changeAddresses), currentBitcoinNetwork);
  const unusedAddresses = await getUnusedAddresses(addresses, currentBitcoinNetwork);
  const unusedChangeAddresses = await getUnusedAddresses(changeAddresses, currentBitcoinNetwork);

  const availableUtxos = await getUtxosForAddresses(addresses.concat(changeAddresses), currentBitcoinNetwork);

  const organizedTransactions = serializeTransactions(transactions, addresses, changeAddresses);

  return [addresses, changeAddresses, organizedTransactions, unusedAddresses, unusedChangeAddresses, availableUtxos];
}

module.exports = {
  getMultisigDeriationPathForNetwork: getMultisigDeriationPathForNetwork,
  createAddressMapFromAddressArray: createAddressMapFromAddressArray,
  getChildPubKeysFromXpubs: getChildPubKeysFromXpubs,
  getChildChangePubKeysFromXpubs: getChildChangePubKeysFromXpubs,
  getDataFromMultisig: getDataFromMultisig,
  getDataFromXPub: getDataFromXPub
}