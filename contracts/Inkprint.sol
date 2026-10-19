// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Inkprint — scan certificates and writer's proof on BOT Chain
/// @notice Two things live here, and neither stores any text — only SHA-256 fingerprints and numbers:
///  - Scan certificates: the fingerprint of a scanned text, the AI score the app reported, its confidence,
///    the detector's name and the time. Anyone holding the same text can find the certificate by its hash.
///  - Writer's proof: a "piece" (a title) with a timestamped trail of draft fingerprints and word counts.
/// The score is reported by the app: this contract cannot check the detector. A certificate proves what text
/// was scanned and when, not that the score is true. No tokens, no payments, no admin.
contract Inkprint {
    struct Certificate {
        address owner;
        bytes32 textHash;
        uint8 score; // 0–100 = AI-likelihood %, NO_SCORE = signals only (the detector was unavailable)
        uint8 confidence; // 0 Low · 1 Medium · 2 High
        string detector;
        uint64 at;
    }

    struct Piece {
        address author;
        string title;
        uint64 createdAt;
    }

    struct Draft {
        bytes32 textHash;
        uint32 words;
        uint64 at;
    }

    uint8 public constant NO_SCORE = 255;
    uint8 public constant MAX_CONFIDENCE = 2;
    uint256 public constant MAX_TITLE = 120; // bytes
    uint256 public constant MAX_DETECTOR = 64; // bytes

    Certificate[] public certs;
    mapping(bytes32 => uint256[]) private certsByHash;
    mapping(address => uint256[]) private certsByOwner;
    Piece[] public pieces;
    mapping(uint256 => Draft[]) private drafts;
    mapping(address => uint256[]) private piecesByAuthor;
    uint256 public draftCount;

    event CertificateStamped(uint256 indexed id, address indexed owner, bytes32 indexed textHash, uint8 score, uint8 confidence, string detector);
    event PieceCreated(uint256 indexed id, address indexed author, string title);
    event DraftStamped(uint256 indexed pieceId, uint256 indexed index, bytes32 indexed textHash, uint32 words);

    error EmptyHash();
    error BadScore();
    error BadConfidence();
    error EmptyDetector();
    error DetectorTooLong();
    error EmptyTitle();
    error TitleTooLong();
    error NoWords();
    error NotAuthor();
    error NotFound();

    // ------------------------------------------------------------------
    // Scan certificates
    // ------------------------------------------------------------------

    /// @notice Stamp the result of a scan. `textHash` is SHA-256 of the normalised text (see README).
    function stampCertificate(bytes32 textHash, uint8 score, uint8 confidence, string calldata detector) external returns (uint256 id) {
        if (textHash == bytes32(0)) revert EmptyHash();
        if (score > 100 && score != NO_SCORE) revert BadScore();
        if (confidence > MAX_CONFIDENCE) revert BadConfidence();
        if (bytes(detector).length == 0) revert EmptyDetector();
        if (bytes(detector).length > MAX_DETECTOR) revert DetectorTooLong();

        id = certs.length;
        certs.push(Certificate(msg.sender, textHash, score, confidence, detector, uint64(block.timestamp)));
        certsByHash[textHash].push(id);
        certsByOwner[msg.sender].push(id);
        emit CertificateStamped(id, msg.sender, textHash, score, confidence, detector);
    }

    function getCertificate(uint256 id) external view returns (Certificate memory) {
        if (id >= certs.length) revert NotFound();
        return certs[id];
    }

    function certificatesForHash(bytes32 textHash) external view returns (uint256[] memory) {
        return certsByHash[textHash];
    }

    function certificatesOf(address owner) external view returns (uint256[] memory) {
        return certsByOwner[owner];
    }

    function certificateCount() external view returns (uint256) {
        return certs.length;
    }

    // ------------------------------------------------------------------
    // Writer's proof
    // ------------------------------------------------------------------

    function createPiece(string calldata title) external returns (uint256 id) {
        if (bytes(title).length == 0) revert EmptyTitle();
        if (bytes(title).length > MAX_TITLE) revert TitleTooLong();
        id = pieces.length;
        pieces.push(Piece(msg.sender, title, uint64(block.timestamp)));
        piecesByAuthor[msg.sender].push(id);
        emit PieceCreated(id, msg.sender, title);
    }

    /// @notice Add a draft's fingerprint to a piece's trail. Only the piece's author can.
    function stampDraft(uint256 pieceId, bytes32 textHash, uint32 words) external {
        if (pieceId >= pieces.length) revert NotFound();
        if (pieces[pieceId].author != msg.sender) revert NotAuthor();
        if (textHash == bytes32(0)) revert EmptyHash();
        if (words == 0) revert NoWords();
        drafts[pieceId].push(Draft(textHash, words, uint64(block.timestamp)));
        draftCount += 1;
        emit DraftStamped(pieceId, drafts[pieceId].length - 1, textHash, words);
    }

    function getPiece(uint256 id) external view returns (Piece memory) {
        if (id >= pieces.length) revert NotFound();
        return pieces[id];
    }

    function getDrafts(uint256 pieceId) external view returns (Draft[] memory) {
        if (pieceId >= pieces.length) revert NotFound();
        return drafts[pieceId];
    }

    function piecesOf(address author) external view returns (uint256[] memory) {
        return piecesByAuthor[author];
    }

    function pieceCount() external view returns (uint256) {
        return pieces.length;
    }
}
