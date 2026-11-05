//! What NOVA can download for its own speech: the ONNX Runtime (CPU and
//! DirectML in one), voices and the offline speech recognizer. Every file is
//! pinned to a revision and a SHA-256 hash; nothing runs before it matches.

use serde::{Deserialize, Serialize};

/// One file of an item.
pub struct File {
    /// Name on disk, in the item's folder.
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    /// Bytes on disk (after unpacking).
    pub size: u64,
    /// Taken out of a zip archive (a NuGet package) at `url` by ranged requests,
    /// so only this file is downloaded, not the whole package.
    pub zip_entry: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Runtime,
    Voice,
    Recognizer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Piper,
    Kokoro,
    Parakeet,
    Onnx,
}

pub struct Item {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    pub engine: Engine,
    pub files: &'static [File],
    pub license: &'static str,
    /// "female" / "male" for voices.
    pub gender: &'static str,
    /// "x_low" … "high" for Piper voices.
    pub quality: &'static str,
    /// Piper: the speaker to use in a multi-speaker voice.
    pub speaker: Option<&'static str>,
    pub experimental: bool,
    /// Changing it makes NOVA download the item again.
    pub version: &'static str,
}

impl Item {
    pub fn size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

const ORT_NUPKG: &str = "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/1.24.4/microsoft.ml.onnxruntime.directml.1.24.4.nupkg";
const DML_NUPKG: &str = "https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg";

/// The runtime's folder name changes with its version, so an update can be
/// installed while the old DLLs are still loaded.
pub const RUNTIME_FOLDER: &str = "runtime-ort1.24.4-dml1.15.4";
pub const RUNTIME_VERSION: &str = "ONNX Runtime 1.24.4 · DirectML 1.15.4";

macro_rules! piper {
    ($path:literal, $name:literal, $onnx_sha:literal, $onnx_size:literal, $json_sha:literal, $json_size:literal) => {
        &[
            File {
                name: "model.onnx",
                url: concat!("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/", $path, "/de_DE-", $name, ".onnx"),
                sha256: $onnx_sha,
                size: $onnx_size,
                zip_entry: None,
            },
            File {
                name: "model.onnx.json",
                url: concat!("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/", $path, "/de_DE-", $name, ".onnx.json"),
                sha256: $json_sha,
                size: $json_size,
                zip_entry: None,
            },
        ]
    };
}

pub const ITEMS: &[Item] = &[
    Item {
        id: "runtime",
        label: "ONNX Runtime + DirectML",
        kind: Kind::Runtime,
        engine: Engine::Onnx,
        files: &[
            File { name: "onnxruntime.dll", url: ORT_NUPKG, sha256: "e7eedec6a6f26dc39dc948276a75ef6d2bee3fff944d874ceed0bbd3b97bff40", size: 17_328_152, zip_entry: Some("runtimes/win-x64/native/onnxruntime.dll") },
            File {
                name: "onnxruntime_providers_shared.dll",
                url: ORT_NUPKG,
                sha256: "265c8daf29637cb259cac8be9f08f2cd45f3883f0f0e4949cbfddd5b4cbec3b6",
                size: 22_040,
                zip_entry: Some("runtimes/win-x64/native/onnxruntime_providers_shared.dll"),
            },
            File { name: "DirectML.dll", url: DML_NUPKG, sha256: "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1", size: 18_527_776, zip_entry: Some("bin/x64-win/DirectML.dll") },
        ],
        license: "MIT (ONNX Runtime) · Microsoft DirectML license",
        gender: "",
        quality: "",
        speaker: None,
        experimental: false,
        version: RUNTIME_FOLDER,
    },
    // Thorsten (medium) lives in the voice folder NOVA 1.4 downloads (with Piper).
    Item { id: "thorsten", label: "Thorsten", kind: Kind::Voice, engine: Engine::Piper, files: &[], license: "CC0 (Thorsten-Voice)", gender: "male", quality: "medium", speaker: None, experimental: false, version: "piper" },
    Item {
        id: "thorsten-high",
        label: "Thorsten (hoch)",
        kind: Kind::Voice,
        engine: Engine::Piper,
        files: piper!("thorsten/high", "thorsten-high", "9df1c43c61149ef9b39e618e2b861fbe41e1fcea9390b2dac62e8761573ea4f1", 113_895_201, "6de734444e4c3f9e33b7ebe2746dbc19b71e85f613e79c65acf623200b99a76a", 4875),
        license: "CC0 (Thorsten-Voice)",
        gender: "male",
        quality: "high",
        speaker: None,
        experimental: false,
        version: "v1.0.0",
    },
    Item {
        id: "thorsten-emotional",
        label: "Thorsten (emotional, neutral)",
        kind: Kind::Voice,
        engine: Engine::Piper,
        files: piper!("thorsten_emotional/medium", "thorsten_emotional-medium", "c1764e652266cd6dcebf1b95c61973df5970a5f5272e94b655ff1ddf9a99d1ff", 76_745_905, "92895b9e99f7cfc13f4a9879da615c3d6e0baa4d660e26d7b685abdd27a6d1d3", 5031),
        license: "CC0 (Thorsten-Voice)",
        gender: "male",
        quality: "medium",
        speaker: Some("neutral"),
        experimental: false,
        version: "v1.0.0",
    },
    Item {
        id: "kerstin",
        label: "Kerstin",
        kind: Kind::Voice,
        engine: Engine::Piper,
        files: piper!("kerstin/low", "kerstin-low", "d352a7641892cebf2903859af94e9ba81a141110215fe3943bcda7f7da401b7a", 63_104_526, "56e708556b7b9b7a53c4f8957e021421e69f11a600962bba554cffbe72cf2d47", 4158),
        license: "CC0",
        gender: "female",
        quality: "low",
        speaker: None,
        experimental: false,
        version: "v1.0.0",
    },
    Item {
        id: "ramona",
        label: "Ramona",
        kind: Kind::Voice,
        engine: Engine::Piper,
        files: piper!("ramona/low", "ramona-low", "a1068592532aad8c49bf3d1a01b8749c11d7dba726689ee28ad64e7b627ae4c5", 63_104_526, "64906ab7a050ac685fa3dcea044baa798f67ed77be164f9c668a69298c6487d2", 4157),
        license: "M-AILABS Speech Dataset license",
        gender: "female",
        quality: "low",
        speaker: None,
        experimental: false,
        version: "v1.0.0",
    },
    Item {
        id: "eva",
        label: "Eva",
        kind: Kind::Voice,
        engine: Engine::Piper,
        files: piper!("eva_k/x_low", "eva_k-x_low", "e88cf290fbfb768bf111330d2e8a46e376b0d85e3423a28bfebbc863a260dad8", 20_628_813, "ef14b3dcb279ab4b18422a7a132877bee7a148821bd91152fb7ae9c4b3d79625", 4158),
        license: "M-AILABS Speech Dataset license",
        gender: "female",
        quality: "x_low",
        speaker: None,
        experimental: false,
        version: "v1.0.0",
    },
    Item {
        id: "karlsson",
        label: "Karlsson",
        kind: Kind::Voice,
        engine: Engine::Piper,
        files: piper!("karlsson/low", "karlsson-low", "f9793bf7e461a472b3916cf260774bfc9812e9eb72601b147ed649d01064e8fe", 63_104_526, "3b2095adbfeede316f22007a0a09d4bfc25514b7189850740b06800a6cfb9838", 4159),
        license: "M-AILABS Speech Dataset license",
        gender: "male",
        quality: "low",
        speaker: None,
        experimental: false,
        version: "v1.0.0",
    },
    Item {
        id: "pavoque",
        label: "Pavoque",
        kind: Kind::Voice,
        engine: Engine::Piper,
        files: piper!("pavoque/low", "pavoque-low", "96cd41fe2303dfe4745422a2580658bdbc5f935b7ee67640a94da7435a502a26", 63_104_526, "07d43d8946e869209a12d9b4fd780e3f277fe9afb305c21491a68bd97e01b74f", 4158),
        license: "CC BY-NC-SA 4.0 (non-commercial)",
        gender: "male",
        quality: "low",
        speaker: None,
        experimental: false,
        version: "v1.0.0",
    },
    Item {
        id: "martin",
        label: "Martin (Kokoro)",
        kind: Kind::Voice,
        engine: Engine::Kokoro,
        files: &[
            File {
                name: "model.onnx",
                url: "https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin/resolve/a1cba7fbf0e72fbae38f0a3a48ce0dc8e6077804/kokoro-martin.onnx",
                sha256: "c302f1d8bc7adf40a842cb550e18c39a5026bdb1afdd29dbb700b501cb49276b",
                size: 325_512_630,
                zip_entry: None,
            },
            File {
                name: "voice.npy",
                url: "https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin/resolve/a1cba7fbf0e72fbae38f0a3a48ce0dc8e6077804/voices-martin.npz",
                // The voice file inside the archive (not the archive itself).
                sha256: "f1e81176e3361e8eb4bc1a19141b5971b1b131f5f5f0f56c753e0d964315409e",
                size: 522_368,
                zip_entry: Some("martin.npy"),
            },
        ],
        license: "Apache-2.0 (Kokoro-82M, kikiri-tts)",
        gender: "male",
        quality: "high",
        speaker: None,
        experimental: true,
        version: "a1cba7f",
    },
    Item {
        id: "parakeet",
        label: "Parakeet TDT 0.6B v3 + Silero VAD",
        kind: Kind::Recognizer,
        engine: Engine::Parakeet,
        files: &[
            File { name: "nemo128.onnx", url: concat!("https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/", "nemo128.onnx"), sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f", size: 139_764, zip_entry: None },
            File {
                name: "encoder-model.int8.onnx",
                url: concat!("https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/", "encoder-model.int8.onnx"),
                sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
                size: 652_183_999,
                zip_entry: None,
            },
            File {
                name: "decoder_joint-model.int8.onnx",
                url: concat!("https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/", "decoder_joint-model.int8.onnx"),
                sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
                size: 18_202_004,
                zip_entry: None,
            },
            File { name: "vocab.txt", url: concat!("https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/", "vocab.txt"), sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d", size: 93_939, zip_entry: None },
            File { name: "silero_vad.onnx", url: "https://huggingface.co/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec/onnx/model.onnx", sha256: "a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808", size: 2_243_022, zip_entry: None },
        ],
        license: "CC-BY-4.0 (NVIDIA Parakeet) · MIT (Silero VAD)",
        gender: "",
        quality: "",
        speaker: None,
        experimental: false,
        version: "8f23f0c",
    },
];

pub fn item(id: &str) -> Option<&'static Item> {
    ITEMS.iter().find(|i| i.id == id)
}

/// The catalog item for a voice preference like "nova:thorsten-high".
pub fn voice(preference: &str) -> Option<&'static Item> {
    item(preference.strip_prefix("nova:")?).filter(|i| i.kind == Kind::Voice)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_item_is_pinned_and_unique() {
        let mut ids = std::collections::HashSet::new();
        for item in ITEMS {
            assert!(ids.insert(item.id), "duplicate {}", item.id);
            for file in item.files {
                assert_eq!(file.sha256.len(), 64, "{}/{}", item.id, file.name);
                assert!(file.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
                assert!(file.url.starts_with("https://huggingface.co/") || file.url.starts_with("https://api.nuget.org/"), "{}", file.url);
                assert!(file.size > 0 && !file.name.contains(['/', '\\']));
                // Revisions are pinned (a tag, a commit or a package version), never "main".
                assert!(!file.url.contains("/resolve/main/"));
            }
        }
        assert_eq!(voice("nova:thorsten-high").map(|i| i.id), Some("thorsten-high"));
        assert!(voice("nova:runtime").is_none() && voice("thorsten").is_none());
    }
}
