use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("CwUSeSb1QzBuHDASQQh7ZDZJSMTKxBT5eRxkRNFPK92L");

#[program]
pub mod solana_smart_contract {
    use super::*;

    /// Creates a new vault for the signer. Each user can create multiple vaults
    /// by providing a unique `vault_id`.
    pub fn create_vault(ctx: Context<CreateVault>, vault_id: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.vault_id = vault_id;
        vault.balance = 0;
        vault.created_at = Clock::get()?.unix_timestamp;
        vault.bump = ctx.bumps.vault;

        msg!(
            "Vault created: owner={}, vault_id={}",
            vault.owner,
            vault.vault_id
        );
        Ok(())
    }

    /// Deposits SOL from the owner's wallet into the vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.balance = vault.balance.checked_add(amount).ok_or(VaultError::Overflow)?;

        msg!("Deposited {} lamports into vault {}", amount, vault.vault_id);
        Ok(())
    }

    /// Withdraws SOL from the vault back to the owner's wallet.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        require!(amount > 0, VaultError::InvalidAmount);
        require!(vault.balance >= amount, VaultError::InsufficientFunds);

        vault.balance = vault.balance.checked_sub(amount).ok_or(VaultError::Overflow)?;

        let vault_lamports = vault.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(Vault::SPACE);

        require!(
            vault_lamports.checked_sub(amount).ok_or(VaultError::Overflow)? >= min_rent,
            VaultError::InsufficientFunds
        );

        **vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;

        msg!(
            "Withdrew {} lamports from vault {}",
            amount,
            vault.vault_id
        );
        Ok(())
    }

    /// Closes the vault and returns all remaining lamports to the owner.
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        msg!(
            "Closing vault {} for owner {}",
            vault.vault_id,
            vault.owner
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct CreateVault<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::SPACE,
        seeds = [b"vault", owner.key().as_ref(), &vault_id.to_le_bytes()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = owner,
        close = owner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub owner: Signer<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub balance: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl Vault {
    pub const SPACE: usize = 32  // owner (Pubkey)
        + 8                       // vault_id (u64)
        + 8                       // balance (u64)
        + 8                       // created_at (i64)
        + 1;                      // bump (u8)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,

    #[msg("Insufficient funds in vault.")]
    InsufficientFunds,

    #[msg("Arithmetic overflow.")]
    Overflow,
}
