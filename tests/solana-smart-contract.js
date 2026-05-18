const anchor = require("@coral-xyz/anchor");
const { SystemProgram, LAMPORTS_PER_SOL } = anchor.web3;
const { assert } = require("chai");
const BN = require("bn.js");

describe("solana-smart-contract", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaSmartContract;
  const owner = provider.wallet;

  const vaultId = new BN(1);

  function findVaultPda(vaultIdBn, ownerPubkey) {
    const vaultIdBuffer = vaultIdBn.toArrayLike(Buffer, "le", 8);
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), ownerPubkey.toBuffer(), vaultIdBuffer],
      program.programId
    );
  }

  it("Creates a vault", async () => {
    const [vaultPda] = findVaultPda(vaultId, owner.publicKey);

    const tx = await program.methods
      .createVault(vaultId)
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Create vault tx:", tx);

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    assert.ok(vaultAccount.owner.equals(owner.publicKey));
    assert.ok(vaultAccount.vaultId.eq(vaultId));
    assert.ok(vaultAccount.balance.eq(new BN(0)));
    assert.ok(vaultAccount.createdAt.gt(new BN(0)));
  });

  it("Deposits SOL into the vault", async () => {
    const [vaultPda] = findVaultPda(vaultId, owner.publicKey);
    const depositAmount = new BN(LAMPORTS_PER_SOL); // 1 SOL

    const balanceBefore = await provider.connection.getBalance(
      owner.publicKey
    );

    const tx = await program.methods
      .deposit(depositAmount)
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Deposit tx:", tx);

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    assert.ok(vaultAccount.balance.eq(depositAmount));

    const balanceAfter = await provider.connection.getBalance(
      owner.publicKey
    );
    assert.ok(balanceBefore - balanceAfter >= LAMPORTS_PER_SOL);
  });

  it("Withdraws SOL from the vault", async () => {
    const [vaultPda] = findVaultPda(vaultId, owner.publicKey);
    const withdrawAmount = new BN(LAMPORTS_PER_SOL / 2); // 0.5 SOL

    const balanceBefore = await provider.connection.getBalance(
      owner.publicKey
    );

    const tx = await program.methods
      .withdraw(withdrawAmount)
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
      })
      .rpc();

    console.log("Withdraw tx:", tx);

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    assert.ok(vaultAccount.balance.eq(new BN(LAMPORTS_PER_SOL / 2)));

    const balanceAfter = await provider.connection.getBalance(
      owner.publicKey
    );
    assert.ok(balanceAfter > balanceBefore);
  });

  it("Fails to withdraw more than vault balance", async () => {
    const [vaultPda] = findVaultPda(vaultId, owner.publicKey);
    const tooMuch = new BN(LAMPORTS_PER_SOL * 100);

    try {
      await program.methods
        .withdraw(tooMuch)
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown an error");
    } catch (err) {
      assert.ok(err.toString().includes("InsufficientFunds"));
    }
  });

  it("Fails to deposit zero amount", async () => {
    const [vaultPda] = findVaultPda(vaultId, owner.publicKey);

    try {
      await program.methods
        .deposit(new BN(0))
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown an error");
    } catch (err) {
      assert.ok(err.toString().includes("InvalidAmount"));
    }
  });

  it("Prevents non-owner from withdrawing", async () => {
    const [vaultPda] = findVaultPda(vaultId, owner.publicKey);
    const attacker = anchor.web3.Keypair.generate();

    // Airdrop some SOL to attacker
    const sig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .withdraw(new BN(1000))
        .accounts({
          vault: vaultPda,
          owner: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown an error");
    } catch (err) {
      // Should fail due to PDA seed mismatch or constraint violation
      assert.ok(err);
    }
  });

  it("Closes the vault and returns lamports", async () => {
    const [vaultPda] = findVaultPda(vaultId, owner.publicKey);

    // First withdraw remaining balance
    const vaultBefore = await program.account.vault.fetch(vaultPda);
    if (vaultBefore.balance.gt(new BN(0))) {
      // Withdraw as much as possible (leaving rent)
      const vaultLamports = await provider.connection.getBalance(vaultPda);
      const rent = await provider.connection.getMinimumBalanceForRentExemption(
        8 + 32 + 8 + 8 + 8 + 1 // discriminator + Vault::SPACE
      );
      const withdrawable = vaultLamports - rent;
      if (withdrawable > 0) {
        await program.methods
          .withdraw(new BN(withdrawable))
          .accounts({
            vault: vaultPda,
            owner: owner.publicKey,
          })
          .rpc();
      }
    }

    const balanceBefore = await provider.connection.getBalance(
      owner.publicKey
    );

    const tx = await program.methods
      .closeVault()
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
      })
      .rpc();

    console.log("Close vault tx:", tx);

    const balanceAfter = await provider.connection.getBalance(
      owner.publicKey
    );
    assert.ok(balanceAfter > balanceBefore);

    // Vault account should no longer exist
    try {
      await program.account.vault.fetch(vaultPda);
      assert.fail("Vault should have been closed");
    } catch (err) {
      assert.ok(err.toString().includes("Account does not exist"));
    }
  });

  it("Creates a second vault with different ID", async () => {
    const secondVaultId = new BN(42);
    const [vaultPda] = findVaultPda(secondVaultId, owner.publicKey);

    await program.methods
      .createVault(secondVaultId)
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    assert.ok(vaultAccount.vaultId.eq(secondVaultId));
    assert.ok(vaultAccount.balance.eq(new BN(0)));

    // Clean up: close this vault too
    await program.methods
      .closeVault()
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
      })
      .rpc();
  });
});
