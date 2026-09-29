using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Rendering;

namespace mdu.ui
{
    /// <summary>
    /// Attach this script to an SDFQuad to make it act as a "cutter" or mask.
    /// It becomes invisible but cuts a hole in any SDFQuadMasked components rendered after it.
    /// </summary>
    public class SDFQuadCutter : SDFQuad
    {
        public override Material GetModifiedMaterial(Material baseMaterial)
        {
            var material = base.GetModifiedMaterial(baseMaterial);
        
            // Create a new material instance to avoid modifying the shared material asset.
            var newMaterial = new Material(material);

            // --- Enable Alpha Clipping ---
            // This is the crucial step. By enabling this keyword, we tell the shader to
            // run its alpha test. The shader will 'discard' any pixel that is fully
            // transparent (outside the SDF shape). Discarded pixels are not written
            // to the stencil buffer, creating a shape-perfect mask.
            // The property "_UseUIAlphaClip" is specifically for this shader.
            newMaterial.SetFloat("_UseUIAlphaClip", 1);
            
            // --- Stencil Settings: Write '1' to the stencil buffer ---
            // These settings now only apply to the pixels that were NOT discarded.
            newMaterial.SetInt("_StencilComp", (int)CompareFunction.Always);
            newMaterial.SetInt("_Stencil", 1);
            newMaterial.SetInt("_StencilOp", (int)StencilOp.Replace);
            newMaterial.SetInt("_StencilWriteMask", 255);
            newMaterial.SetInt("_StencilReadMask", 255);

            // --- Color Mask: Make the object invisible ---
            // This still prevents the cutter's shape from being drawn to the screen,
            // which is what we want. We only need its effect on the stencil buffer.
            newMaterial.SetInt("_ColorMask", 0);

            return newMaterial;
        }
    }
}