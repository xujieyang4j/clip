import Foundation

enum CubeLUTError: Error, LocalizedError, Equatable {
    case fileTooLarge
    case invalidUTF8
    case unsupportedOneDimensionalLUT
    case missingDimension
    case invalidDimension
    case invalidDomain
    case invalidEntryCount(expected: Int, actual: Int)

    var errorDescription: String? {
        switch self {
        case .fileTooLarge: return "The LUT file is larger than 32 MB."
        case .invalidUTF8: return "The LUT file is not valid UTF-8 text."
        case .unsupportedOneDimensionalLUT: return "Only 3D .cube LUT files are supported."
        case .missingDimension: return "The LUT file does not contain LUT_3D_SIZE."
        case .invalidDimension: return "The LUT dimension must be between 2 and 64."
        case .invalidDomain: return "The LUT input domain is invalid."
        case let .invalidEntryCount(expected, actual):
            return "The LUT requires \(expected) color entries but contains \(actual)."
        }
    }
}

struct CubeLUT: Equatable, Sendable {
    static let maximumFileSize = 32 * 1_024 * 1_024
    struct Entry: Equatable, Sendable {
        var red: Float
        var green: Float
        var blue: Float
    }

    var dimension: Int
    var domainMinimum: Entry
    var domainMaximum: Entry
    var entries: [Entry]

    static func parse(data: Data) throws -> CubeLUT {
        guard data.count <= maximumFileSize else { throw CubeLUTError.fileTooLarge }
        guard let text = String(data: data, encoding: .utf8) else { throw CubeLUTError.invalidUTF8 }
        return try parse(text: text)
    }

    static func parse(text: String) throws -> CubeLUT {
        var dimension: Int?
        var domainMinimum = Entry(red: 0, green: 0, blue: 0)
        var domainMaximum = Entry(red: 1, green: 1, blue: 1)
        var entries: [Entry] = []

        for rawLine in text.components(separatedBy: .newlines) {
            let content = rawLine.split(separator: "#", maxSplits: 1).first ?? ""
            let fields = content.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            guard !fields.isEmpty else { continue }
            switch fields[0].uppercased() {
            case "TITLE":
                continue
            case "LUT_1D_SIZE":
                throw CubeLUTError.unsupportedOneDimensionalLUT
            case "LUT_3D_SIZE":
                guard fields.count >= 2, let value = Int(fields[1]), (2...64).contains(value) else {
                    throw CubeLUTError.invalidDimension
                }
                dimension = value
            case "DOMAIN_MIN":
                domainMinimum = try parseEntry(fields)
            case "DOMAIN_MAX":
                domainMaximum = try parseEntry(fields)
            default:
                guard Float(fields[0]) != nil else { continue }
                entries.append(try parseEntry(fields, startsAt: 0))
            }
        }

        guard let dimension else { throw CubeLUTError.missingDimension }
        guard domainMaximum.red > domainMinimum.red,
              domainMaximum.green > domainMinimum.green,
              domainMaximum.blue > domainMinimum.blue else {
            throw CubeLUTError.invalidDomain
        }
        let expected = dimension * dimension * dimension
        guard entries.count == expected else {
            throw CubeLUTError.invalidEntryCount(expected: expected, actual: entries.count)
        }
        return CubeLUT(
            dimension: dimension, domainMinimum: domainMinimum,
            domainMaximum: domainMaximum, entries: entries
        )
    }

    var rgbaData: Data {
        var values: [Float] = []
        values.reserveCapacity(entries.count * 4)
        for entry in entries {
            values.append(entry.red)
            values.append(entry.green)
            values.append(entry.blue)
            values.append(1)
        }
        return values.withUnsafeBytes { buffer in
            Data(buffer)
        }
    }

    private static func parseEntry(_ fields: [String], startsAt start: Int = 1) throws -> Entry {
        guard fields.count >= start + 3,
              let red = Float(fields[start]),
              let green = Float(fields[start + 1]),
              let blue = Float(fields[start + 2]),
              red.isFinite, green.isFinite, blue.isFinite else {
            throw CubeLUTError.invalidDomain
        }
        return Entry(red: red, green: green, blue: blue)
    }
}
